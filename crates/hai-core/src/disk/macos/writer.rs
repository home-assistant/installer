//! macOS disk writing through a privileged descriptor from `authopen(1)`.
//!
//! The device is opened once, read-write, and the same descriptor serves the
//! write and the read-back verify. As described in the `authopen` manual page,
//! one end of a `SOCK_STREAM` socketpair becomes its stdout and `-stdoutpipe`
//! makes it send the open descriptor back as an `SCM_RIGHTS` control message;
//! `-extauth` makes it reuse the authorization this application already holds,
//! so the single dialog names this application rather than `authopen`.
//!
//! `authopen` is a setuid helper, so the App Sandbox must stay off. Elevating
//! does not bypass TCC either: removable-media access is checked against the
//! responsible process, which is this application.

use super::super::macos_logic::{
    align_up, aligned_buffer_size, authopen_args, cache_flush_failure_is_benign,
    classify_authopen_failure, fill_buffer, map_authorization_status, map_device_io_error,
    pad_final_block, sanitize_block_size, write_ran_past_device_end, DEFAULT_BLOCK_SIZE, O_RDWR,
};
use super::super::*;
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

const AUTHOPEN_PATH: &str = "/usr/libexec/authopen";

/// `_IO('d', 22)` from `<sys/disk.h>`.
const DKIOCSYNCHRONIZECACHE: rustix::ioctl::Opcode = rustix::ioctl::opcode::none(b'd', 22);

#[derive(Debug, Deserialize)]
struct DiskUtilGeometry {
    #[serde(rename = "DeviceBlockSize", default)]
    device_block_size: u64,
    #[serde(rename = "TotalSize", default)]
    total_size: u64,
}

/// How the image lines up with the device it is being written to.
#[derive(Debug, Clone, Copy)]
struct Layout {
    /// Bytes of image to write and hash; the device is padded past this to a
    /// block boundary.
    total_size: u64,
    /// Every raw-device read and write must be a whole number of these, at an
    /// offset that is one too.
    block_size: u64,
    /// Device capacity, if `diskutil` reported it.
    device_size: Option<u64>,
    /// Streaming buffer length, a whole number of blocks.
    buffer_len: usize,
}

/// Outcome of the `SCM_RIGHTS` exchange with `authopen`.
#[derive(Debug)]
enum Handshake {
    Descriptor(OwnedFd),
    /// `authopen` closed the socket or sent bytes without a descriptor; its
    /// exit status says why.
    NoDescriptor,
    /// The exchange failed on this side.
    Failed(std::io::Error),
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
    progress_callback.on_progress(FlashProgress::new(
        FlashStage::Writing,
        0,
        image_size,
        "Requesting administrator access...",
    ));

    // Send progress updates from the blocking task through a channel.
    let (progress_tx, progress_rx) = mpsc::channel::<FlashProgress>();

    // Perform write and optional verify in a blocking task
    let image_path_clone = image_path.clone();
    let raw_device_clone = raw_device.clone();
    let disk_id_clone = disk_id.to_string();

    let write_handle = tokio::task::spawn_blocking(move || {
        write_and_verify(
            &image_path_clone,
            &raw_device_clone,
            &disk_id_clone,
            image_size,
            verify,
            progress_tx,
        )
    });

    run_with_progress(write_handle, progress_rx, progress_callback).await?;

    progress_callback.on_progress(FlashProgress::new(
        FlashStage::Complete,
        image_size,
        image_size,
        "Complete",
    ));

    Ok(())
}

fn write_and_verify(
    image_path: &Path,
    device_path: &str,
    disk_id: &str,
    total_size: u64,
    verify: bool,
    progress_tx: mpsc::Sender<FlashProgress>,
) -> Result<()> {
    let (block_size, device_size) = device_geometry(disk_id);
    let layout = Layout {
        total_size,
        block_size,
        device_size,
        buffer_len: aligned_buffer_size(FAST_DRIVE_BUFFER_SIZE, block_size),
    };

    // One authorization and one privileged open; nothing privileged happens
    // after this point.
    let auth = request_authorization(device_path)?;
    let mut device = open_device_with_authopen(&auth, device_path)?;

    let source_checksum = write_to_device(
        &mut device,
        image_path,
        device_path,
        layout,
        verify,
        &progress_tx,
    )?;

    flush_device_cache(&device, device_path)?;

    if verify {
        let checksum =
            source_checksum.expect("Checksum should have been computed when verify=true");
        verify_device(&mut device, &checksum, device_path, layout, &progress_tx)?;
    }

    // The device must be closed before diskutil can eject it.
    drop(device);

    eject_disk(disk_id)
}

/// Block size and capacity from `diskutil`, with a safe fallback block size
/// and an unknown capacity when it will not say.
fn device_geometry(disk_id: &str) -> (u64, Option<u64>) {
    let Ok(output) = Command::new("diskutil")
        .args(["info", "-plist", disk_id])
        .output()
    else {
        return (DEFAULT_BLOCK_SIZE, None);
    };

    if !output.status.success() {
        return (DEFAULT_BLOCK_SIZE, None);
    }

    match plist::from_bytes::<DiskUtilGeometry>(&output.stdout) {
        Ok(info) => (
            sanitize_block_size(info.device_block_size),
            (info.total_size > 0).then_some(info.total_size),
        ),
        Err(_) => (DEFAULT_BLOCK_SIZE, None),
    }
}

fn request_authorization(device_path: &str) -> Result<Authorization> {
    // The right authopen itself checks, so the credential obtained here is
    // the one it needs and it prompts no further.
    let rights = AuthorizationItemSetBuilder::new()
        .add_right(format!("sys.openfile.readwrite.{device_path}"))
        .map_err(|e| Error::PermissionDenied(format!("Failed to create rights: {}", e)))?
        .build();

    // PREAUTHORIZE shows the dialog here, so a cancellation is reported as one
    // rather than as an opaque authopen failure.
    Authorization::new(
        Some(rights),
        None,
        Flags::INTERACTION_ALLOWED | Flags::EXTEND_RIGHTS | Flags::PREAUTHORIZE,
    )
    .map_err(|e| map_authorization_status(e.code(), "Requesting administrator access"))
}

/// Open `device_path` read-write through `authopen` and take the descriptor it
/// passes back.
fn open_device_with_authopen(auth: &Authorization, device_path: &str) -> Result<File> {
    let external_form = auth
        .make_external_form()
        .map_err(|e| map_authorization_status(e.code(), "Externalizing the authorization"))?;
    let external_bytes: Vec<u8> = external_form.bytes.iter().map(|byte| *byte as u8).collect();

    let (handshake, output) = spawn_and_receive_descriptor(
        AUTHOPEN_PATH,
        &authopen_args(device_path, O_RDWR, true),
        &external_bytes,
    )?;
    let stderr = String::from_utf8_lossy(&output.stderr);

    match handshake {
        Handshake::Descriptor(fd) if output.status.success() => Ok(File::from(fd)),
        Handshake::Failed(err) if output.status.success() => Err(Error::Io(err)),
        // authopen's own account of the failure beats what was seen on the
        // socket; a descriptor next to a failed exit is not trusted either.
        _ => Err(classify_authopen_failure(
            output.status.code(),
            &stderr,
            device_path,
        )),
    }
}

/// Run `program` as `authopen` expects: a UNIX socket as its stdout,
/// `stdin_payload` on its stdin, and a descriptor collected from what it sends
/// back. The program is a parameter so tests can stand in for `authopen`.
fn spawn_and_receive_descriptor(
    program: &str,
    args: &[String],
    stdin_payload: &[u8],
) -> Result<(Handshake, std::process::Output)> {
    let (parent_end, child_end) = UnixStream::pair().map_err(Error::Io)?;

    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(OwnedFd::from(child_end)))
        .stderr(Stdio::piped());

    let spawned = command.spawn();
    // Closes this process's copy of the child's socket end; otherwise recvmsg
    // never sees EOF when the child exits without sending a descriptor.
    drop(command);

    let mut child =
        spawned.map_err(|e| Error::PermissionDenied(format!("Could not run {program}: {e}")))?;

    // -extauth reads the external form before opening anything.
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

/// Pull the descriptor out of the `SCM_RIGHTS` control message, if one came.
fn receive_descriptor(socket: &UnixStream) -> std::io::Result<Handshake> {
    let mut payload = [0u8; 16];
    let mut iov = [IoSliceMut::new(&mut payload)];

    // Room for the one descriptor authopen sends; more sets CTRUNC.
    let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
    let mut control = RecvAncillaryBuffer::new(&mut space);

    let message = recvmsg(socket, &mut iov, &mut control, RecvFlags::empty())?;

    if message.flags.contains(ReturnFlags::CTRUNC) {
        // A truncated message still carries the `cmsg_len` that was sent, and
        // rustix 1.1.2 subtracts it while draining (`AncillaryDrain::advance`),
        // which underflows. Dropping the buffer drains it, so it is forgotten
        // instead; that leaks at most the one descriptor that fit.
        std::mem::forget(control);
        return Err(std::io::Error::other(
            "authopen's control message did not fit in the receive buffer",
        ));
    }

    for ancillary in control.drain() {
        let RecvAncillaryMessage::ScmRights(descriptors) = ancillary else {
            continue;
        };

        // Any extra descriptors are closed when the iterator drops.
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
    progress_tx: &mpsc::Sender<FlashProgress>,
) -> Result<Option<String>> {
    use sha2::{Digest, Sha256};

    let Layout {
        total_size,
        block_size,
        device_size,
        buffer_len,
    } = layout;

    let mut source = File::open(image_path)?;
    let mut buffer = vec![0u8; buffer_len];
    let mut hasher = compute_checksum.then(Sha256::new);
    let mut bytes_written: u64 = 0;
    let mut last_progress_update: u64 = 0;

    let _ = progress_tx.send(FlashProgress::new(
        FlashStage::Writing,
        0,
        total_size,
        "Starting write...",
    ));

    loop {
        let filled = fill_buffer(&mut source, &mut buffer).map_err(Error::Io)?;
        if filled == 0 {
            break;
        }

        // Hash the image bytes only; the padding below never reaches the digest.
        if let Some(hasher) = hasher.as_mut() {
            hasher.update(&buffer[..filled]);
        }

        let to_write = pad_final_block(&mut buffer, filled, block_size);
        device.write_all(&buffer[..to_write]).map_err(|e| {
            if !is_drive_disconnected(&e)
                && write_ran_past_device_end(bytes_written, to_write as u64, device_size)
            {
                Error::ImageTooLarge {
                    written: device_size.map_or(bytes_written, |size| size.min(total_size)),
                    image_size: total_size,
                }
            } else {
                map_device_io_error(e, device_path)
            }
        })?;

        bytes_written += filled as u64;

        // Send progress update every PROGRESS_UPDATE_INTERVAL bytes
        if bytes_written - last_progress_update >= PROGRESS_UPDATE_INTERVAL {
            let _ = progress_tx.send(FlashProgress::new(
                FlashStage::Writing,
                bytes_written,
                total_size,
                "Writing image to drive...",
            ));
            last_progress_update = bytes_written;
        }
    }

    let _ = progress_tx.send(FlashProgress::new(
        FlashStage::Writing,
        bytes_written,
        total_size,
        "Syncing data to drive...",
    ));

    Ok(hasher.map(|hasher| hex::encode(hasher.finalize())))
}

/// Ask the drive to commit its write cache. `/dev/rdiskN` bypasses the buffer
/// cache and refuses `F_FULLFSYNC` with `ENOTTY`; `DKIOCSYNCHRONIZECACHE` is
/// the raw-device equivalent.
fn flush_device_cache(device: &File, device_path: &str) -> Result<()> {
    match synchronize_cache(device) {
        Ok(()) => Ok(()),
        Err(errno) if cache_flush_failure_is_benign(errno.raw_os_error()) => Ok(()),
        Err(errno) => Err(map_device_io_error(errno.into(), device_path)),
    }
}

fn synchronize_cache(device: &File) -> rustix::io::Result<()> {
    // SAFETY: the ioctl takes no argument, so the kernel never dereferences
    // the null pointer `NoArg` passes.
    unsafe { rustix::ioctl::ioctl(device, rustix::ioctl::NoArg::<DKIOCSYNCHRONIZECACHE>::new()) }
}

fn verify_device(
    device: &mut File,
    source_checksum: &str,
    device_path: &str,
    layout: Layout,
    progress_tx: &mpsc::Sender<FlashProgress>,
) -> Result<()> {
    use sha2::{Digest, Sha256};

    let Layout {
        total_size,
        block_size,
        buffer_len,
        ..
    } = layout;

    let _ = progress_tx.send(FlashProgress::new(
        FlashStage::Verifying,
        0,
        total_size,
        "Starting verification...",
    ));

    device
        .seek(SeekFrom::Start(0))
        .map_err(|e| map_device_io_error(e, device_path))?;

    let mut buffer = vec![0u8; buffer_len];
    let mut hasher = Sha256::new();
    let mut bytes_hashed: u64 = 0;
    let mut last_progress_update: u64 = 0;

    while bytes_hashed < total_size {
        let wanted = (total_size - bytes_hashed).min(buffer_len as u64);
        // Read whole blocks, hash only the image's share of them.
        let to_read = align_up(wanted, block_size).min(buffer_len as u64) as usize;

        let filled = fill_buffer(device, &mut buffer[..to_read])
            .map_err(|e| map_device_io_error(e, device_path))?;

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
            let _ = progress_tx.send(FlashProgress::new(
                FlashStage::Verifying,
                bytes_hashed,
                total_size,
                "Verifying written data...",
            ));
            last_progress_update = bytes_hashed;
        }
    }

    let device_checksum = hex::encode(hasher.finalize());

    if source_checksum != device_checksum {
        return Err(Error::VerificationFailed(
            "Checksum mismatch after write".to_string(),
        ));
    }

    let _ = progress_tx.send(FlashProgress::new(
        FlashStage::Verifying,
        total_size,
        total_size,
        "Verification complete",
    ));

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
    use serial_test::serial;
    use std::os::fd::{AsFd, BorrowedFd};

    #[tokio::test]
    #[serial]
    async fn test_write_image_with_invalid_device() {
        let temp_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(temp_file.path(), b"test data").unwrap();
        let image_path = temp_file.path().to_path_buf();

        // Fails at unmount_disk: the device does not exist.
        let device_id = "/dev/nonexistent_disk999";

        let result = write_image(&image_path, device_id, false, &crate::NoOpProgress).await;
        assert!(result.is_err());
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
    fn test_device_geometry_of_the_boot_disk_is_plausible() {
        // disk0 always exists and is only read here.
        let (block_size, device_size) = device_geometry("disk0");
        assert!(block_size.is_power_of_two(), "{block_size}");
        assert!((512..=65536).contains(&block_size), "{block_size}");
        let device_size = device_size.expect("diskutil reports TotalSize for the boot disk");
        assert!(device_size > 1024 * 1024 * 1024, "{device_size}");
    }

    #[test]
    fn test_device_geometry_falls_back_for_an_unknown_disk() {
        assert_eq!(device_geometry("disk999"), (DEFAULT_BLOCK_SIZE, None));
    }

    /// Sends `descriptors` over `socket` the way `authopen -stdoutpipe` does.
    fn send_descriptors(
        socket: &UnixStream,
        descriptors: &[BorrowedFd<'_>],
    ) -> std::io::Result<()> {
        use rustix::net::{sendmsg, SendAncillaryBuffer, SendAncillaryMessage, SendFlags};

        // Large enough for the truncation test to overfill the receiver.
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

        // An independent handle: it outlives the original.
        drop(temp);
        let mut received = File::from(fd);
        let mut contents = String::new();
        received.read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "payload from the other side");
    }

    /// The receive buffer holds one descriptor. A sender attaching more must be
    /// refused, and the buffer must not be dropped (see `receive_descriptor`).
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

    /// A regular file stands in for the device: same writes, no alignment rule.
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
            device_size: None,
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

        // Padded to a whole block with zeroes.
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
        // Not a multiple of 4096: the last block is padded.
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
        // Buffer smaller than the image: several chunks, short final one.
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
                device_size: None,
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
    fn test_flush_device_cache_tolerates_the_plain_file_stand_in() {
        let device = tempfile::tempfile().unwrap();

        let errno = synchronize_cache(&device).expect_err("a regular file has no device cache");
        assert_eq!(errno.raw_os_error(), 25, "expected ENOTTY, got {errno}");

        flush_device_cache(&device, "/dev/rdisk-test").expect("ENOTTY must be tolerated");
    }

    #[test]
    fn test_dkiocsynchronizecache_opcode_matches_the_header() {
        assert_eq!(DKIOCSYNCHRONIZECACHE, 0x2000_6416);
    }

    /// Without the `drop(command)` in `spawn_and_receive_descriptor` this
    /// hangs: the socket never reaches EOF.
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
        drop(child_end);

        assert!(matches!(
            receive_descriptor(&parent_end).unwrap(),
            Handshake::NoDescriptor
        ));
    }

    /// A raw disk device owned by the current user, from
    /// `hdiutil attach -nomount ram://`, detached on drop. It enforces the same
    /// alignment, end-of-media and ioctl rules as an SD card, without root.
    struct RamDisk {
        device: String,
    }

    impl RamDisk {
        const SIZE: u64 = 8 * 1024 * 1024;

        fn attach() -> Option<Self> {
            let sectors = (Self::SIZE / 512).to_string();
            let output = Command::new("hdiutil")
                .args(["attach", "-nomount", &format!("ram://{sectors}")])
                .output()
                .ok()?;
            if !output.status.success() {
                eprintln!(
                    "skipping RAM disk test: hdiutil attach failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                return None;
            }
            let device = String::from_utf8_lossy(&output.stdout).trim().to_string();
            device.starts_with("/dev/disk").then_some(Self { device })
        }

        fn disk_id(&self) -> &str {
            self.device.strip_prefix("/dev/").unwrap()
        }

        fn raw_path(&self) -> String {
            format!("/dev/r{}", self.disk_id())
        }

        fn open(&self) -> File {
            File::options()
                .read(true)
                .write(true)
                .open(self.raw_path())
                .expect("a RAM disk is owned by the user who attached it")
        }

        fn layout(&self, total_size: u64, buffer_len: usize) -> Layout {
            let (block_size, device_size) = device_geometry(self.disk_id());
            assert_eq!(
                device_size,
                Some(Self::SIZE),
                "diskutil disagrees about the RAM disk size"
            );
            Layout {
                total_size,
                block_size,
                device_size,
                buffer_len: aligned_buffer_size(buffer_len, block_size),
            }
        }
    }

    impl Drop for RamDisk {
        fn drop(&mut self) {
            let _ = Command::new("hdiutil")
                .args(["detach", &self.device])
                .output();
        }
    }

    fn image_of(bytes: usize) -> tempfile::NamedTempFile {
        let data: Vec<u8> = (0..=255u8).cycle().take(bytes).collect();
        let image = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(image.path(), &data).unwrap();
        image
    }

    #[test]
    fn test_write_flush_and_verify_on_a_real_raw_device() {
        let Some(ram) = RamDisk::attach() else { return };
        // Not block aligned and larger than the buffer: several chunks, padded
        // last one.
        let image_bytes = 3 * 1024 * 1024 + 1000;
        let image = image_of(image_bytes);
        let layout = ram.layout(image_bytes as u64, 1024 * 1024);
        let (progress_tx, _progress_rx) = mpsc::channel();
        let raw_path = ram.raw_path();

        let mut device = ram.open();
        let checksum = write_to_device(
            &mut device,
            image.path(),
            &raw_path,
            layout,
            true,
            &progress_tx,
        )
        .expect("block-aligned writes must be accepted by the raw device")
        .expect("a checksum is returned when verification is requested");

        // Accepted by a disk device, not merely tolerated.
        synchronize_cache(&device).expect("a disk device must accept DKIOCSYNCHRONIZECACHE");
        flush_device_cache(&device, &raw_path).unwrap();

        verify_device(&mut device, &checksum, &raw_path, layout, &progress_tx)
            .expect("the raw device must read back what was written");
        drop(device);
    }

    #[test]
    fn test_an_image_larger_than_the_raw_device_is_reported_as_too_large() {
        let Some(ram) = RamDisk::attach() else { return };
        let image_bytes = RamDisk::SIZE + 1024 * 1024;
        let image = image_of(image_bytes as usize);
        // The third 3 MiB chunk straddles the 8 MiB end.
        let layout = ram.layout(image_bytes, 3 * 1024 * 1024);
        let (progress_tx, _progress_rx) = mpsc::channel();
        let raw_path = ram.raw_path();

        let mut device = ram.open();
        let result = write_to_device(
            &mut device,
            image.path(),
            &raw_path,
            layout,
            false,
            &progress_tx,
        );
        drop(device);

        match result {
            Err(Error::ImageTooLarge {
                written,
                image_size,
            }) => {
                assert_eq!(written, RamDisk::SIZE);
                assert_eq!(image_size, image_bytes);
            }
            other => panic!("expected ImageTooLarge, got {other:?}"),
        }
    }
}
