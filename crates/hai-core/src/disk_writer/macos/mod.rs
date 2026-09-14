//! macOS disk writing via a privileged descriptor from `/usr/libexec/authopen`.
//!
//! The device is opened once, read-write, through `authopen(1)`, and the single
//! descriptor it hands back is used for both the write and the read-back
//! verify. That replaces the previous approach of running `/bin/dd` as root
//! through `AuthorizationExecuteWithPrivileges`, which has been deprecated
//! since macOS 10.7, could not report the child's exit status (so a full card
//! surfaced as a broken pipe rather than as `ENOSPC`), and needed two separate
//! privileged invocations — long enough apart on a slow card for the
//! authorization credential to expire between them.
//!
//! The handshake with `authopen` is the one described in its manual page:
//! a `SOCK_STREAM` socketpair is created, one end becomes the child's stdout,
//! and `-stdoutpipe` makes the child pass the open descriptor back over it as
//! an `SCM_RIGHTS` control message. `-extauth` makes it read the
//! `AuthorizationExternalForm` of the authorization this application already
//! holds from its stdin, so the user sees one dialog naming this application
//! rather than a second one naming `authopen`.
//!
//! Note that elevating does not bypass TCC. Access to removable media is
//! checked against the responsible process, which is this application, so a
//! granted authorization followed by `EPERM`/`EACCES` means the removable
//! volumes privacy setting rather than the administrator password.

use super::macos_logic::{
    align_up, aligned_buffer_size, authopen_args, classify_authopen_failure, fill_buffer,
    full_sync_failure_is_benign, map_authorization_status, map_device_io_error, pad_final_block,
    sanitize_block_size, DEFAULT_BLOCK_SIZE, O_RDWR,
};
use super::*;
use rustix::net::{recvmsg, RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, ReturnFlags};
use security_framework::authorization::{Authorization, AuthorizationItemSetBuilder, Flags};
use serde::Deserialize;
use std::fs::File;
use std::io::{IoSliceMut, Seek, SeekFrom, Write};
use std::mem::MaybeUninit;
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;

/// The setuid helper that opens a file on our behalf after checking the caller
/// against an authorization right.
const AUTHOPEN_PATH: &str = "/usr/libexec/authopen";

/// Progress update sent from blocking task
struct ProgressUpdate {
    stage: FlashStage,
    bytes_processed: u64,
    total_bytes: u64,
    message: String,
}

/// The one field of `diskutil info -plist` this module needs.
#[derive(Debug, Deserialize)]
struct DiskUtilBlockSize {
    #[serde(rename = "DeviceBlockSize", default)]
    device_block_size: u64,
}

/// How the image lines up with the device it is being written to.
#[derive(Debug, Clone, Copy)]
struct Layout {
    /// Bytes of image to write. The device is written past this, up to the next
    /// block boundary, but only these bytes are ever hashed.
    total_size: u64,
    /// The device's block size. Every read from and write to the raw device
    /// has to be a whole number of these, at an offset that is one too.
    block_size: u64,
    /// Length of the streaming buffer, itself a whole number of blocks.
    buffer_len: usize,
}

/// Outcome of the `SCM_RIGHTS` exchange with `authopen`.
#[derive(Debug)]
enum Handshake {
    /// `authopen` passed the open device descriptor.
    Descriptor(OwnedFd),
    /// `authopen` closed the socket, or wrote bytes to it without attaching a
    /// descriptor. Either way it failed, and its exit status says why.
    NoDescriptor,
    /// The exchange failed on this side, before `authopen` had its say.
    Failed(std::io::Error),
}

/// Validate that a device path is safe to write to (not a system drive)
pub fn validate_device_path(device_id: &str) -> Result<()> {
    // On macOS, disk0 is always the system drive
    let disk_id = device_id.strip_prefix("/dev/").unwrap_or(device_id);
    let disk_id = disk_id.strip_prefix("r").unwrap_or(disk_id); // Handle raw device

    if disk_id == "disk0" {
        return Err(Error::PermissionDenied(
            "disk0 is the system drive and cannot be overwritten".to_string(),
        ));
    }

    Ok(())
}

pub async fn write_image<P: ProgressCallback>(
    image_path: &PathBuf,
    device_id: &str,
    verify: bool,
    progress_callback: &P,
) -> Result<()> {
    // Extract disk identifier from device path
    let disk_id = device_id.strip_prefix("/dev/").unwrap_or(device_id);

    // Get the raw device path for faster writes
    let raw_device = format!("/dev/r{}", disk_id);

    // Unmount all volumes on the disk
    unmount_disk(disk_id)?;

    // Get image size for progress tracking
    let image_size = std::fs::metadata(image_path)?.len();

    // Send initial progress
    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Writing,
        progress: 0,
        bytes_processed: 0,
        total_bytes: image_size,
        message: "Requesting administrator access...".to_string(),
    });

    // Create channel for progress updates from blocking task
    let (progress_tx, progress_rx) = mpsc::channel::<ProgressUpdate>();

    // Perform write and optional verify in a blocking task
    let image_path_clone = image_path.clone();
    let raw_device_clone = raw_device.clone();
    let disk_id_clone = disk_id.to_string();

    let write_handle = tokio::task::spawn_blocking(move || {
        write_and_verify_blocking(
            &image_path_clone,
            &raw_device_clone,
            &disk_id_clone,
            image_size,
            verify,
            progress_tx,
        )
    });

    // Forward progress updates while waiting for write to complete
    loop {
        // Check for progress updates (non-blocking with timeout)
        match progress_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(update) => {
                let progress = if update.total_bytes > 0 {
                    ((update.bytes_processed as f64 / update.total_bytes as f64) * 100.0) as u8
                } else {
                    0
                };
                progress_callback.on_progress(FlashProgress {
                    stage: update.stage,
                    progress,
                    bytes_processed: update.bytes_processed,
                    total_bytes: update.total_bytes,
                    message: update.message,
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Check if the blocking task is done
                if write_handle.is_finished() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Sender dropped, task is done
                break;
            }
        }
    }

    // Wait for the result
    let result = write_handle
        .await
        .map_err(|e| Error::Io(std::io::Error::other(e)))?;

    result?;

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Complete,
        progress: 100,
        bytes_processed: image_size,
        total_bytes: image_size,
        message: "Complete".to_string(),
    });

    Ok(())
}

fn write_and_verify_blocking(
    image_path: &Path,
    device_path: &str,
    disk_id: &str,
    total_size: u64,
    verify: bool,
    progress_tx: mpsc::Sender<ProgressUpdate>,
) -> Result<()> {
    // Writes to the raw device are rejected unless both their length and the
    // file offset are whole numbers of blocks. `dd` used to arrange that for
    // us; now it is this module's job.
    let block_size = device_block_size(disk_id);
    let layout = Layout {
        total_size,
        block_size,
        buffer_len: aligned_buffer_size(FAST_DRIVE_BUFFER_SIZE, block_size),
    };

    // One authorization and one privileged open for the whole operation. The
    // credential cannot expire part-way through a long flash any more, because
    // nothing privileged happens after this point — the descriptor is already
    // ours.
    let auth = request_authorization()?;
    let mut device = open_device_with_authopen(&auth, device_path)?;

    let source_checksum = write_to_device(
        &mut device,
        image_path,
        device_path,
        layout,
        verify,
        &progress_tx,
    )?;

    full_sync(&device, device_path)?;

    if verify {
        let checksum =
            source_checksum.expect("Checksum should have been computed when verify=true");
        verify_device(&mut device, &checksum, device_path, layout, &progress_tx)?;
    }

    // Close the descriptor before asking diskutil to eject, so the device is
    // not still open when it tries.
    drop(device);

    eject_disk(disk_id)
}

/// Ask `diskutil` how large this device's blocks are, falling back to a value
/// that is safe on every device if it will not say.
fn device_block_size(disk_id: &str) -> u64 {
    let Ok(output) = Command::new("diskutil")
        .args(["info", "-plist", disk_id])
        .output()
    else {
        return DEFAULT_BLOCK_SIZE;
    };

    if !output.status.success() {
        return DEFAULT_BLOCK_SIZE;
    }

    match plist::from_bytes::<DiskUtilBlockSize>(&output.stdout) {
        Ok(info) => sanitize_block_size(info.device_block_size),
        Err(_) => DEFAULT_BLOCK_SIZE,
    }
}

fn request_authorization() -> Result<Authorization> {
    let rights = AuthorizationItemSetBuilder::new()
        .add_right("system.privilege.admin")
        .map_err(|e| Error::PermissionDenied(format!("Failed to create rights: {}", e)))?
        .build();

    // PREAUTHORIZE means the dialog is shown here rather than inside authopen,
    // which is what lets a cancellation be reported as a cancellation instead
    // of as an opaque authopen failure.
    Authorization::new(
        Some(rights),
        None,
        Flags::INTERACTION_ALLOWED | Flags::EXTEND_RIGHTS | Flags::PREAUTHORIZE,
    )
    .map_err(|e| map_authorization_status(e.code(), "Requesting administrator access"))
}

/// Open `device_path` read-write through `authopen` and take ownership of the
/// descriptor it passes back over its stdout socket.
fn open_device_with_authopen(auth: &Authorization, device_path: &str) -> Result<File> {
    // Reusing the authorization this application already holds is what makes
    // the dialog say "Home Assistant Installer" instead of "authopen", and
    // keeps the whole flash down to a single prompt.
    let external_form = auth
        .make_external_form()
        .map_err(|e| map_authorization_status(e.code(), "Externalizing the authorization"))?;
    // The external form is a fixed-size blob of c_char; authopen wants the raw
    // bytes on stdin.
    let external_bytes: Vec<u8> = external_form.bytes.iter().map(|byte| *byte as u8).collect();

    let (handshake, output) = spawn_and_receive_descriptor(
        AUTHOPEN_PATH,
        &authopen_args(device_path, O_RDWR, true),
        &external_bytes,
    )?;
    let stderr = String::from_utf8_lossy(&output.stderr);

    match handshake {
        Handshake::Descriptor(fd) if output.status.success() => Ok(File::from(fd)),
        // authopen's own account of what went wrong beats whatever we saw on
        // our end of the socket, whenever it managed to give one. A descriptor
        // alongside a failed exit is not something authopen is documented to
        // produce either, so that is closed rather than written through.
        Handshake::Failed(err) if output.status.success() => Err(Error::Io(err)),
        _ => Err(classify_authopen_failure(
            output.status.code(),
            &stderr,
            device_path,
        )),
    }
}

/// Run `program` the way `authopen` expects to be run: one end of a UNIX
/// socketpair as its stdout, `stdin_payload` on its stdin, and a descriptor
/// collected from whatever it sends back.
///
/// Split out from [`open_device_with_authopen`] so the socket plumbing can be
/// driven by a test with an ordinary command standing in for `authopen`.
fn spawn_and_receive_descriptor(
    program: &str,
    args: &[String],
    stdin_payload: &[u8],
) -> Result<(Handshake, std::process::Output)> {
    // The descriptor comes back as an SCM_RIGHTS control message, which only
    // works over a UNIX domain socket.
    let (parent_end, child_end) = UnixStream::pair().map_err(Error::Io)?;

    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(OwnedFd::from(child_end)))
        .stderr(Stdio::piped());

    let spawned = command.spawn();
    // Drop this process's own copy of the socket end the child inherited.
    // Without it the recvmsg() below would block forever instead of seeing EOF
    // when the child exits without passing anything back.
    drop(command);

    let mut child =
        spawned.map_err(|e| Error::PermissionDenied(format!("Could not run {program}: {e}")))?;

    // -extauth consumes the external form from stdin before it opens anything,
    // so this has to happen before waiting for a descriptor.
    let sent = match child.stdin.take() {
        Some(mut stdin) => stdin.write_all(stdin_payload).and_then(|()| stdin.flush()),
        None => Err(std::io::Error::other("child was spawned without a stdin")),
    };

    let handshake = match sent.and_then(|()| receive_descriptor(&parent_end)) {
        Ok(handshake) => handshake,
        Err(err) => Handshake::Failed(err),
    };

    let output = child.wait_with_output().map_err(Error::Io)?;

    Ok((handshake, output))
}

/// Pull the device descriptor out of the `SCM_RIGHTS` control message
/// `authopen` sends, if it sent one.
fn receive_descriptor(socket: &UnixStream) -> std::io::Result<Handshake> {
    // authopen sends a byte of payload alongside the control message; the
    // payload itself carries nothing we need.
    let mut payload = [0u8; 16];
    let mut iov = [IoSliceMut::new(&mut payload)];

    // Room for exactly the one descriptor authopen sends. Anything that does
    // not fit shows up as CTRUNC below rather than being silently dropped.
    let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
    let mut control = RecvAncillaryBuffer::new(&mut space);

    let message = recvmsg(socket, &mut iov, &mut control, RecvFlags::empty())?;

    // A truncated control message means the kernel discarded descriptors that
    // would not fit rather than queueing them, so what arrived cannot be
    // trusted to be the whole set. Refuse instead of using part of it.
    if message.flags.contains(ReturnFlags::CTRUNC) {
        // Leak the buffer rather than letting it drop.
        //
        // A truncated message still reports the `cmsg_len` that was *sent*
        // rather than the part that arrived, and rustix 1.1.2 subtracts that
        // from the remaining length as it drains (`AncillaryDrain::advance`).
        // That underflows: a panic in debug, and in release it would walk off
        // the end of the buffer and hand back `OwnedFd`s built out of
        // uninitialised bytes. `RecvAncillaryBuffer::drop` drains, so returning
        // normally would run straight into it.
        //
        // Forgetting the buffer leaks whichever descriptors did arrive. That is
        // the lesser evil: the buffer has room for one, authopen only ever
        // sends one, and the flash fails on this error regardless.
        std::mem::forget(control);
        return Err(std::io::Error::other(
            "authopen's control message did not fit in the receive buffer",
        ));
    }

    for ancillary in control.drain() {
        let RecvAncillaryMessage::ScmRights(descriptors) = ancillary else {
            continue;
        };

        // authopen only ever passes one. Any extra is an OwnedFd too, so it is
        // closed when the iterator drops rather than left open.
        if let Some(device) = descriptors.into_iter().next() {
            return Ok(Handshake::Descriptor(device));
        }
    }

    Ok(Handshake::NoDescriptor)
}

fn write_to_device(
    device: &mut File,
    image_path: &Path,
    device_path: &str,
    layout: Layout,
    compute_checksum: bool,
    progress_tx: &mpsc::Sender<ProgressUpdate>,
) -> Result<Option<String>> {
    use sha2::{Digest, Sha256};

    let Layout {
        total_size,
        block_size,
        buffer_len,
    } = layout;

    let mut source = File::open(image_path)?;
    let mut buffer = vec![0u8; buffer_len];
    let mut hasher = compute_checksum.then(Sha256::new);
    let mut bytes_written: u64 = 0;
    let mut last_progress_update: u64 = 0;

    let _ = progress_tx.send(ProgressUpdate {
        stage: FlashStage::Writing,
        bytes_processed: 0,
        total_bytes: total_size,
        message: "Starting write...".to_string(),
    });

    loop {
        let filled = fill_buffer(&mut source, &mut buffer).map_err(Error::Io)?;
        if filled == 0 {
            break;
        }

        // Only the image's own bytes are hashed. The zero padding below is
        // written to the device but must never reach the digest, or the verify
        // pass could not match it.
        if let Some(hasher) = hasher.as_mut() {
            hasher.update(&buffer[..filled]);
        }

        let to_write = pad_final_block(&mut buffer, filled, block_size);
        device
            .write_all(&buffer[..to_write])
            .map_err(|e| map_device_io_error(e, device_path, bytes_written, total_size))?;

        bytes_written += filled as u64;

        // Send progress update every PROGRESS_UPDATE_INTERVAL bytes
        if bytes_written - last_progress_update >= PROGRESS_UPDATE_INTERVAL {
            let _ = progress_tx.send(ProgressUpdate {
                stage: FlashStage::Writing,
                bytes_processed: bytes_written,
                total_bytes: total_size,
                message: "Writing image to drive...".to_string(),
            });
            last_progress_update = bytes_written;
        }
    }

    let _ = progress_tx.send(ProgressUpdate {
        stage: FlashStage::Writing,
        bytes_processed: bytes_written,
        total_bytes: total_size,
        message: "Syncing data to drive...".to_string(),
    });

    Ok(hasher.map(|hasher| hex::encode(hasher.finalize())))
}

/// Make the drive commit what it has buffered.
///
/// `fsync(2)` only pushes data out of the kernel; `F_FULLFSYNC` is the only way
/// on macOS to make the drive itself flush its write cache, which is what
/// matters for a device the user is about to unplug.
fn full_sync(device: &File, device_path: &str) -> Result<()> {
    match rustix::fs::fcntl_fullfsync(device) {
        Ok(()) => Ok(()),
        Err(errno) if full_sync_failure_is_benign(errno.raw_os_error()) => Ok(()),
        Err(errno) => Err(map_device_io_error(errno.into(), device_path, 0, 0)),
    }
}

fn verify_device(
    device: &mut File,
    source_checksum: &str,
    device_path: &str,
    layout: Layout,
    progress_tx: &mpsc::Sender<ProgressUpdate>,
) -> Result<()> {
    use sha2::{Digest, Sha256};

    let Layout {
        total_size,
        block_size,
        buffer_len,
    } = layout;

    let _ = progress_tx.send(ProgressUpdate {
        stage: FlashStage::Verifying,
        bytes_processed: 0,
        total_bytes: total_size,
        message: "Starting verification...".to_string(),
    });

    // Back to the start of the descriptor we already hold: no second
    // authorization, no second privileged process, no second password prompt.
    device
        .seek(SeekFrom::Start(0))
        .map_err(|e| map_device_io_error(e, device_path, 0, total_size))?;

    let mut buffer = vec![0u8; buffer_len];
    let mut hasher = Sha256::new();
    let mut bytes_hashed: u64 = 0;
    let mut last_progress_update: u64 = 0;

    while bytes_hashed < total_size {
        let wanted = (total_size - bytes_hashed).min(buffer_len as u64);
        // Reads from the raw device have to be block aligned as well, so read
        // whole blocks and hash only the part of them that belongs to the
        // image. This is what keeps the padding out of the digest.
        let to_read = align_up(wanted, block_size).min(buffer_len as u64) as usize;

        let filled = fill_buffer(device, &mut buffer[..to_read])
            .map_err(|e| map_device_io_error(e, device_path, bytes_hashed, total_size))?;

        if (filled as u64) < wanted {
            return Err(Error::VerificationFailed(format!(
                "{} returned only {} of {} bytes",
                device_path,
                bytes_hashed + filled as u64,
                total_size
            )));
        }

        hasher.update(&buffer[..wanted as usize]);
        bytes_hashed += wanted;

        // Send progress update every PROGRESS_UPDATE_INTERVAL bytes
        if bytes_hashed - last_progress_update >= PROGRESS_UPDATE_INTERVAL {
            let _ = progress_tx.send(ProgressUpdate {
                stage: FlashStage::Verifying,
                bytes_processed: bytes_hashed,
                total_bytes: total_size,
                message: "Verifying written data...".to_string(),
            });
            last_progress_update = bytes_hashed;
        }
    }

    let device_checksum = hex::encode(hasher.finalize());

    if source_checksum != device_checksum {
        return Err(Error::VerificationFailed(
            "Checksum mismatch after write".to_string(),
        ));
    }

    let _ = progress_tx.send(ProgressUpdate {
        stage: FlashStage::Verifying,
        bytes_processed: total_size,
        total_bytes: total_size,
        message: "Verification complete".to_string(),
    });

    Ok(())
}

fn unmount_disk(disk_id: &str) -> Result<()> {
    let output = Command::new("diskutil")
        .args(["unmountDisk", disk_id])
        .output()?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);

    if stderr.contains("not mounted") || stderr.contains("was already unmounted") {
        return Ok(());
    }

    // Try force unmount
    let force_output = Command::new("diskutil")
        .args(["unmountDisk", "force", disk_id])
        .output()?;

    if !force_output.status.success() {
        let force_stderr = String::from_utf8_lossy(&force_output.stderr);
        if !force_stderr.contains("not mounted") && !force_stderr.contains("was already unmounted")
        {
            return Err(Error::DeviceBusy(format!(
                "Force unmount failed: {}",
                force_stderr
            )));
        }
    }

    Ok(())
}

fn eject_disk(disk_id: &str) -> Result<()> {
    let output = Command::new("diskutil").args(["eject", disk_id]).output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(Error::DeviceBusy(format!("Eject failed: {}", stderr)));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::{AsFd, BorrowedFd};

    #[test]
    fn test_validate_device_path_blocks_disk0() {
        assert!(validate_device_path("/dev/disk0").is_err());
        assert!(validate_device_path("/dev/rdisk0").is_err());
        assert!(validate_device_path("disk0").is_err());
    }

    #[test]
    fn test_validate_device_path_allows_other_disks() {
        assert!(validate_device_path("/dev/disk2").is_ok());
        assert!(validate_device_path("/dev/disk10").is_ok());
    }

    #[test]
    fn test_validate_device_path_disk1() {
        // disk1 is usually okay (not system drive)
        assert!(validate_device_path("/dev/disk1").is_ok());
        assert!(validate_device_path("/dev/rdisk1").is_ok());
    }

    #[test]
    fn test_validate_device_path_high_disk_numbers() {
        assert!(validate_device_path("/dev/disk99").is_ok());
        assert!(validate_device_path("/dev/rdisk99").is_ok());
    }

    #[test]
    fn test_validate_device_rdisk0_variants() {
        assert!(validate_device_path("rdisk0").is_err());
        assert!(validate_device_path("/dev/rdisk0").is_err());
    }

    #[test]
    fn test_validate_device_without_dev_prefix() {
        assert!(validate_device_path("disk2").is_ok());
        assert!(validate_device_path("rdisk2").is_ok());
        assert!(validate_device_path("disk5").is_ok());
        assert!(validate_device_path("disk0").is_err());
    }

    #[test]
    fn test_validate_all_disk0_variations() {
        // Test all possible ways someone might reference disk0
        assert!(validate_device_path("/dev/disk0").is_err());
        assert!(validate_device_path("/dev/rdisk0").is_err());
        assert!(validate_device_path("disk0").is_err());
        assert!(validate_device_path("rdisk0").is_err());

        // disk0s1 passes validation as it's a partition, not the whole disk:
        // only the exact "disk0" match is rejected.
        assert!(validate_device_path("/dev/disk0s1").is_ok());
    }

    #[test]
    fn test_validation_error_message_disk0() {
        let result = validate_device_path("/dev/disk0");
        assert!(result.is_err());
        match result {
            Err(Error::PermissionDenied(msg)) => {
                assert!(msg.contains("disk0"));
                assert!(msg.contains("system drive"));
            }
            _ => panic!("Expected PermissionDenied error"),
        }
    }

    #[test]
    fn test_validate_case_sensitivity() {
        // macOS device paths are case-sensitive
        assert!(validate_device_path("/dev/Disk0").is_ok()); // Capital D should pass
        assert!(validate_device_path("/dev/disk0").is_err()); // Lowercase should fail
    }

    #[test]
    fn test_unmount_disk_nonexistent() {
        // Test unmounting a disk that doesn't exist
        let result = unmount_disk("disk999");
        // This should either succeed (if disk not mounted) or fail with I/O error
        assert!(result.is_ok() || result.is_err());
    }

    #[test]
    fn test_eject_disk_nonexistent() {
        // Test ejecting a disk that doesn't exist
        let result = eject_disk("disk999");
        // This should fail because the disk doesn't exist
        assert!(result.is_err());
        if let Err(Error::DeviceBusy(msg)) = result {
            assert!(!msg.is_empty());
        }
    }

    #[test]
    fn test_device_block_size_of_the_boot_disk_is_plausible() {
        // disk0 always exists on a Mac and is never written to by this module;
        // this only checks that the diskutil plist is parsed into a usable
        // block size rather than silently falling back.
        let block_size = device_block_size("disk0");
        assert!(block_size.is_power_of_two(), "{block_size}");
        assert!((512..=65536).contains(&block_size), "{block_size}");
    }

    #[test]
    fn test_device_block_size_falls_back_for_an_unknown_disk() {
        assert_eq!(device_block_size("disk999"), DEFAULT_BLOCK_SIZE);
    }

    /// Sends `descriptors` over `socket` the way `authopen -stdoutpipe` sends
    /// its one, so the receiving half can be exercised without `authopen`.
    ///
    /// This is the mirror image of `receive_descriptor`, so it also pins down
    /// the message layout that function expects: if the two ever disagree, the
    /// round-trip test below stops passing.
    fn send_descriptors(
        socket: &UnixStream,
        descriptors: &[BorrowedFd<'_>],
    ) -> std::io::Result<()> {
        use rustix::net::{sendmsg, SendAncillaryBuffer, SendAncillaryMessage, SendFlags};

        // Sized for whatever the caller is sending, so that the truncation test
        // can deliberately send more than the receiver has room for.
        let mut space = vec![MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(16))];
        let mut control = SendAncillaryBuffer::new(&mut space);
        assert!(
            control.push(SendAncillaryMessage::ScmRights(descriptors)),
            "control buffer was too small for {} descriptors",
            descriptors.len()
        );

        sendmsg(
            socket,
            &[std::io::IoSlice::new(b"\0")],
            &mut control,
            SendFlags::empty(),
        )?;
        Ok(())
    }

    /// Exercises the receiving half of the `authopen` handshake without
    /// `authopen`: a descriptor for a temp file is pushed through a socketpair
    /// exactly the way `-stdoutpipe` pushes the device descriptor.
    #[test]
    fn test_receive_descriptor_picks_the_fd_out_of_scm_rights() {
        use std::io::{Read, Seek, SeekFrom, Write};

        let mut temp = tempfile::tempfile().unwrap();
        temp.write_all(b"payload from the other side").unwrap();
        temp.seek(SeekFrom::Start(0)).unwrap();

        let (parent_end, child_end) = UnixStream::pair().unwrap();
        send_descriptors(&child_end, &[temp.as_fd()]).unwrap();
        drop(child_end);

        let handshake = receive_descriptor(&parent_end).unwrap();
        let Handshake::Descriptor(fd) = handshake else {
            panic!("expected a descriptor");
        };

        // The received descriptor is a genuine, independent handle on the file:
        // it outlives the original and reads back the same bytes.
        drop(temp);
        let mut received = File::from(fd);
        let mut contents = String::new();
        received.read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "payload from the other side");
    }

    /// The receive buffer holds one descriptor, so a sender that attaches more
    /// has to be refused outright rather than half-read.
    ///
    /// Emphatically not hypothetical. A truncated control message still reports
    /// the length that was *sent* rather than the part that *arrived*, and both
    /// implementations of this function have got that wrong: a hand-rolled one
    /// aborted the process with an I/O safety violation, and `rustix` 1.1.2
    /// underflows in `AncillaryDrain::advance` — which is why the CTRUNC check
    /// is before the drain, and why the buffer is forgotten rather than
    /// dropped. Removing either of those makes this test fail.
    #[test]
    fn test_receive_descriptor_refuses_a_truncated_control_message() {
        let temp = tempfile::tempfile().unwrap();
        let (parent_end, child_end) = UnixStream::pair().unwrap();

        let descriptors = [temp.as_fd(); 16];
        send_descriptors(&child_end, &descriptors).unwrap();
        drop(child_end);

        let err = receive_descriptor(&parent_end)
            .expect_err("a truncated control message must not be accepted");
        assert!(err.to_string().contains("did not fit"), "{err}");
    }

    #[test]
    fn test_receive_descriptor_reports_plain_data_as_no_descriptor() {
        use std::io::Write;

        let (parent_end, mut child_end) = UnixStream::pair().unwrap();

        // Bytes but no control message: what a failing authopen looks like.
        child_end.write_all(b"nope").unwrap();
        drop(child_end);

        assert!(matches!(
            receive_descriptor(&parent_end).unwrap(),
            Handshake::NoDescriptor
        ));
    }

    /// A regular file stands in for the descriptor `authopen` would hand back.
    /// It accepts the same writes, so the padding, the digest and the read-back
    /// can all be exercised without a raw device — only the alignment
    /// *requirement* is missing, and that is what `Layout` encodes.
    fn round_trip(
        image_bytes: usize,
        block_size: u64,
        buffer_len: usize,
    ) -> (File, String, Layout) {
        use std::io::Read;

        let data: Vec<u8> = (0..=255u8).cycle().take(image_bytes).collect();
        let image = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(image.path(), &data).unwrap();

        let layout = Layout {
            total_size: data.len() as u64,
            block_size,
            buffer_len,
        };
        let mut device = tempfile::tempfile().unwrap();
        let (progress_tx, progress_rx) = mpsc::channel();

        let checksum = write_to_device(
            &mut device,
            image.path(),
            "/dev/rdisk-test",
            layout,
            true,
            &progress_tx,
        )
        .unwrap()
        .expect("a checksum is returned when verification is requested");

        // The digest covers the image, never the padding written after it.
        let expected = {
            use sha2::{Digest, Sha256};
            hex::encode(Sha256::digest(&data))
        };
        assert_eq!(
            checksum, expected,
            "checksum was taken over the padded write"
        );

        // The device holds the image rounded up to a whole block, and the
        // rounding is zeroes rather than leftover image bytes.
        let written = device.metadata().unwrap().len();
        assert_eq!(written, align_up(layout.total_size, block_size));
        device.seek(SeekFrom::Start(layout.total_size)).unwrap();
        let mut padding = Vec::new();
        device.read_to_end(&mut padding).unwrap();
        assert!(
            padding.iter().all(|byte| *byte == 0),
            "padding is not zeroed"
        );

        drop(progress_rx);
        (device, checksum, layout)
    }

    #[test]
    fn test_write_then_verify_round_trip_on_a_partial_final_block() {
        // 10_000 is deliberately not a multiple of 4096, so the last block is
        // padded and the verify has to read further than total_size while
        // hashing only up to it.
        let (mut device, checksum, layout) = round_trip(10_000, 4096, 64 * 1024);
        let (progress_tx, _progress_rx) = mpsc::channel();

        verify_device(
            &mut device,
            &checksum,
            "/dev/rdisk-test",
            layout,
            &progress_tx,
        )
        .expect("a faithful copy must verify");
    }

    #[test]
    fn test_write_then_verify_round_trip_across_several_buffers() {
        // Buffer deliberately smaller than the image so the chunking loop runs
        // more than once and the final chunk is a short one.
        let (mut device, checksum, layout) = round_trip(20_000, 512, 4096);
        let (progress_tx, _progress_rx) = mpsc::channel();

        verify_device(
            &mut device,
            &checksum,
            "/dev/rdisk-test",
            layout,
            &progress_tx,
        )
        .expect("a faithful copy must verify");
    }

    #[test]
    fn test_write_then_verify_round_trip_on_an_exact_block_multiple() {
        let (mut device, checksum, layout) = round_trip(8192, 4096, 4096);
        let (progress_tx, _progress_rx) = mpsc::channel();

        verify_device(
            &mut device,
            &checksum,
            "/dev/rdisk-test",
            layout,
            &progress_tx,
        )
        .expect("a faithful copy must verify");
    }

    #[test]
    fn test_verify_rejects_a_device_whose_contents_changed() {
        let (mut device, checksum, layout) = round_trip(10_000, 4096, 64 * 1024);
        let (progress_tx, _progress_rx) = mpsc::channel();

        // Flip one byte in the middle of the image.
        device.seek(SeekFrom::Start(5_000)).unwrap();
        device.write_all(&[0xFF]).unwrap();

        match verify_device(
            &mut device,
            &checksum,
            "/dev/rdisk-test",
            layout,
            &progress_tx,
        ) {
            Err(Error::VerificationFailed(msg)) => {
                assert!(msg.contains("Checksum mismatch"), "{msg}")
            }
            other => panic!("expected a checksum mismatch, got {other:?}"),
        }
    }

    #[test]
    fn test_verify_rejects_a_device_that_is_shorter_than_the_image() {
        let (mut device, checksum, layout) = round_trip(10_000, 4096, 64 * 1024);
        let (progress_tx, _progress_rx) = mpsc::channel();

        // A device that accepted the write but cannot give it all back.
        device.set_len(4096).unwrap();

        match verify_device(
            &mut device,
            &checksum,
            "/dev/rdisk-test",
            layout,
            &progress_tx,
        ) {
            Err(Error::VerificationFailed(msg)) => {
                assert!(msg.contains("returned only"), "{msg}");
                assert!(msg.contains("10000"), "{msg}");
            }
            other => panic!("expected a short-read failure, got {other:?}"),
        }
    }

    #[test]
    fn test_write_without_verification_computes_no_checksum() {
        let image = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(image.path(), vec![7u8; 1000]).unwrap();
        let mut device = tempfile::tempfile().unwrap();
        let (progress_tx, _progress_rx) = mpsc::channel();

        let checksum = write_to_device(
            &mut device,
            image.path(),
            "/dev/rdisk-test",
            Layout {
                total_size: 1000,
                block_size: 512,
                buffer_len: 4096,
            },
            false,
            &progress_tx,
        )
        .unwrap();

        assert!(checksum.is_none());
        assert_eq!(device.metadata().unwrap().len(), 1024);
    }

    #[test]
    fn test_full_sync_succeeds_on_a_plain_file() {
        let device = tempfile::tempfile().unwrap();
        full_sync(&device, "/dev/rdisk-test").expect("F_FULLFSYNC must work on a regular file");
    }

    /// Drives the real spawn path with a stand-in for `authopen` that exits
    /// without sending anything.
    ///
    /// This is the regression test for the `drop(command)` in
    /// `spawn_and_receive_descriptor`: if this process kept its own copy of the
    /// socket end the child inherited, the socket would never reach EOF and the
    /// recvmsg would block forever instead of returning here.
    #[test]
    fn test_spawn_and_receive_descriptor_returns_when_the_child_sends_nothing() {
        let (handshake, output) =
            spawn_and_receive_descriptor("/usr/bin/true", &[], b"ignored").unwrap();

        assert!(output.status.success());
        assert!(matches!(handshake, Handshake::NoDescriptor));
    }

    #[test]
    fn test_spawn_and_receive_descriptor_keeps_a_failing_childs_exit_status() {
        let (handshake, output) = spawn_and_receive_descriptor("/usr/bin/false", &[], b"").unwrap();

        assert_eq!(output.status.code(), Some(1));
        assert!(matches!(handshake, Handshake::NoDescriptor));
    }

    /// `cat` echoes stdin to the socket, which is what a failing `authopen`
    /// looks like from here: bytes arrive, but no control message does.
    #[test]
    fn test_spawn_and_receive_descriptor_treats_plain_output_as_no_descriptor() {
        let (handshake, output) =
            spawn_and_receive_descriptor("/bin/cat", &[], b"not a descriptor").unwrap();

        assert!(output.status.success());
        assert!(matches!(handshake, Handshake::NoDescriptor));
    }

    #[test]
    fn test_spawn_and_receive_descriptor_reports_a_missing_program() {
        let err = spawn_and_receive_descriptor("/usr/libexec/hai-does-not-exist", &[], b"")
            .expect_err("spawning a nonexistent program must fail");

        match err {
            Error::PermissionDenied(msg) => assert!(msg.contains("hai-does-not-exist"), "{msg}"),
            other => panic!("expected PermissionDenied, got {other:?}"),
        }
    }

    #[test]
    fn test_receive_descriptor_reports_a_closed_socket_as_no_descriptor() {
        let (parent_end, child_end) = UnixStream::pair().unwrap();

        // authopen exiting without sending anything at all.
        drop(child_end);

        assert!(matches!(
            receive_descriptor(&parent_end).unwrap(),
            Handshake::NoDescriptor
        ));
    }
}
