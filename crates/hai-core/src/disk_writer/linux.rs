//! Linux disk writing via udisks2 over D-Bus (polkit handles authorization).

use super::*;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::process::Command;
use std::sync::mpsc;
use zbus::proxy::CacheProperties;
use zbus::zvariant::{OwnedFd, OwnedObjectPath, Value};
use zbus::Connection;

/// Progress update sent from blocking task
struct ProgressUpdate {
    stage: FlashStage,
    bytes_processed: u64,
    total_bytes: u64,
    message: String,
}

/// Validate that a device path is safe to write to (not a system drive)
pub fn validate_device_path(device_id: &str) -> Result<()> {
    // Require the removable/hotplug signal device enumeration filters on
    // instead of a name deny-list: /dev/sda or /dev/nvme0n1 are legitimate
    // USB targets on machines that boot from another disk. A mounted
    // system drive is additionally caught by the exclusive (O_EXCL) open
    // at write time.
    let device_path = if device_id.starts_with("/dev/") {
        device_id.to_string()
    } else {
        format!("/dev/{}", device_id)
    };
    if device_id.is_empty() || !is_removable_or_hotplug(&device_path) {
        return Err(Error::PermissionDenied(format!(
            "{} is not a removable drive and cannot be overwritten",
            device_id
        )));
    }

    Ok(())
}

/// Whether lsblk reports the drive as removable or hot-plugged — the same
/// signal (and tool) device enumeration filters on, so the two layers cannot
/// drift, and lsblk's bus-chain hotplug derivation (usb, mmc, thunderbolt, …)
/// is not reimplemented here.
fn is_removable_or_hotplug(device_path: &str) -> bool {
    let output = match Command::new("lsblk")
        .args(["--nodeps", "--json", "--output", "RM,HOTPLUG", device_path])
        .output()
    {
        Ok(output) if output.status.success() => output.stdout,
        // Unknown device (or no lsblk at all): not a valid target.
        _ => return false,
    };
    parse_lsblk_removable(&output)
}

fn parse_lsblk_removable(json: &[u8]) -> bool {
    #[derive(serde::Deserialize)]
    struct LsblkOutput {
        blockdevices: Vec<LsblkFlags>,
    }
    #[derive(serde::Deserialize)]
    struct LsblkFlags {
        #[serde(default)]
        rm: Option<bool>,
        #[serde(default)]
        hotplug: Option<bool>,
    }
    serde_json::from_slice::<LsblkOutput>(json)
        .ok()
        .and_then(|out| out.blockdevices.into_iter().next())
        .is_some_and(|dev| dev.rm == Some(true) || dev.hotplug == Some(true))
}

pub async fn write_image<P: ProgressCallback>(
    image_path: &PathBuf,
    device_id: &str,
    verify: bool,
    progress_callback: &P,
) -> Result<()> {
    let connection = Connection::system()
        .await
        .map_err(|e| map_udisks_error(e, "connecting to the system bus"))?;
    let block_path = resolve_block_path(&connection, device_id).await?;

    unmount_device(&connection, &block_path).await?;

    let image_size = std::fs::metadata(image_path)?.len();

    let device = open_device_rw(&connection, &block_path).await?;

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Writing,
        progress: 0,
        bytes_processed: 0,
        total_bytes: image_size,
        message: "Writing image to device...".to_string(),
    });

    // Create channel for progress updates from the blocking task.
    let (progress_tx, progress_rx) = mpsc::channel::<ProgressUpdate>();

    let image_path_clone = image_path.clone();

    let write_handle = tokio::task::spawn_blocking(move || {
        write_and_verify(&image_path_clone, device, image_size, verify, progress_tx)
    });

    let forward = |update: ProgressUpdate| {
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
    };

    loop {
        match progress_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(update) => forward(update),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if write_handle.is_finished() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // Drain updates the task buffered after it finished (e.g. the final
    // "Write complete" / "Verification complete") so they aren't lost.
    while let Ok(update) = progress_rx.try_recv() {
        forward(update);
    }

    write_handle
        .await
        .map_err(|e| Error::Io(std::io::Error::other(e)))??;

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Finalizing,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Syncing data...".to_string(),
    });

    let _ = Command::new("sync").output();

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Complete,
        progress: 100,
        bytes_processed: image_size,
        total_bytes: image_size,
        message: "Complete".to_string(),
    });

    Ok(())
}

fn map_udisks_error(err: zbus::Error, context: &str) -> Error {
    // Remedy only; the DiskServiceUnavailable variant supplies the
    // "Disk service unavailable:" prefix.
    const UNAVAILABLE: &str = "install and enable udisks2 to flash drives.";

    if let zbus::Error::MethodError(name, message, _) = &err {
        let name = name.as_str();
        // udisks2 isn't installed / not activatable on the bus.
        if name.contains("ServiceUnknown") || name.contains("NameHasNoOwner") {
            return Error::DiskServiceUnavailable(UNAVAILABLE.to_string());
        }
        // User dismissed the polkit dialog.
        if name.contains("NotAuthorizedDismissed") {
            return Error::PermissionDenied("Authorization was canceled".to_string());
        }
        if name.contains("NotAuthorized") {
            return Error::PermissionDenied(
                message
                    .clone()
                    .unwrap_or_else(|| "Not authorized to access the device".to_string()),
            );
        }
        // udisks may use the dedicated DeviceBusy name, but often reports a
        // busy device as Error.Failed with "Device or resource busy" in the
        // message instead, so check both.
        if name.contains("DeviceBusy")
            || message
                .as_deref()
                .is_some_and(|m| m.contains("Device or resource busy"))
        {
            return Error::DeviceBusy(context.to_string());
        }
        return Error::Io(std::io::Error::other(format!(
            "udisks2 error while {context}: {err}"
        )));
    }

    // Not a method error → couldn't reach the bus/service at all.
    Error::DiskServiceUnavailable(format!("{UNAVAILABLE} ({err})"))
}

#[zbus::proxy(
    interface = "org.freedesktop.UDisks2.Manager",
    default_service = "org.freedesktop.UDisks2",
    default_path = "/org/freedesktop/UDisks2/Manager",
    gen_blocking = false
)]
trait UDisks2Manager {
    /// Resolve a device spec like `{"path": "/dev/sdb"}` to block-object paths.
    fn resolve_device(
        &self,
        devspec: HashMap<&str, Value<'_>>,
        options: HashMap<&str, Value<'_>>,
    ) -> zbus::Result<Vec<OwnedObjectPath>>;
}

#[zbus::proxy(
    interface = "org.freedesktop.UDisks2.Block",
    default_service = "org.freedesktop.UDisks2",
    gen_blocking = false
)]
trait UDisks2Block {
    /// Open the whole device; `mode` is `"r"`, `"w"`, or `"rw"`.
    fn open_device(&self, mode: &str, options: HashMap<&str, Value<'_>>) -> zbus::Result<OwnedFd>;
}

#[zbus::proxy(
    interface = "org.freedesktop.UDisks2.Filesystem",
    default_service = "org.freedesktop.UDisks2",
    gen_blocking = false
)]
trait UDisks2Filesystem {
    fn unmount(&self, options: HashMap<&str, Value<'_>>) -> zbus::Result<()>;
}

#[zbus::proxy(
    interface = "org.freedesktop.UDisks2.PartitionTable",
    default_service = "org.freedesktop.UDisks2",
    gen_blocking = false
)]
trait UDisks2PartitionTable {
    #[zbus(property)]
    fn partitions(&self) -> zbus::Result<Vec<OwnedObjectPath>>;
}

async fn resolve_block_path(conn: &Connection, device_id: &str) -> Result<OwnedObjectPath> {
    let manager = UDisks2ManagerProxy::new(conn)
        .await
        .map_err(|e| map_udisks_error(e, "connecting to udisks2"))?;

    let mut devspec = HashMap::new();
    devspec.insert("path", Value::from(device_id));

    let paths = manager
        .resolve_device(devspec, HashMap::new())
        .await
        .map_err(|e| map_udisks_error(e, "resolving the device"))?;

    paths
        .into_iter()
        .next()
        .ok_or_else(|| Error::DeviceNotFound(device_id.to_string()))
}

/// Open the device read-write via udisks2 (raises the polkit prompt).
async fn open_device_rw(conn: &Connection, path: &OwnedObjectPath) -> Result<File> {
    let block = UDisks2BlockProxy::builder(conn)
        .path(path.to_string())
        .map_err(|e| map_udisks_error(e, "addressing the device"))?
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .map_err(|e| map_udisks_error(e, "addressing the device"))?;

    // O_EXCL: to make sure we have exclusive access to the disk and error if not
    // O_SYNC: so each write reaches the card before returning to keep the
    // progress bar in sync
    let mut options = HashMap::new();
    options.insert("flags", Value::from(libc::O_EXCL | libc::O_SYNC));
    let fd = block
        .open_device("rw", options)
        .await
        .map_err(|e| map_udisks_error(e, "opening the device"))?;
    Ok(File::from(std::os::fd::OwnedFd::from(fd)))
}

fn write_and_verify(
    image_path: &PathBuf,
    mut device: File,
    total_size: u64,
    verify: bool,
    progress_tx: mpsc::Sender<ProgressUpdate>,
) -> Result<()> {
    write_to_device(image_path, &mut device, total_size, &progress_tx)?;

    if verify {
        // Evict the pages we just wrote from the cache so the read-back
        // comes from the medium, not RAM
        drop_device_cache(&device);

        // Tag verify-phase failures as VerificationFailed so the caller can
        // label them "Verification failed" rather than "Write failed".
        let verified = (|| {
            device.seek(SeekFrom::Start(0)).map_err(|e| {
                if is_drive_disconnected(&e) {
                    Error::DriveDisconnected
                } else {
                    Error::Io(e)
                }
            })?;
            verify_write(image_path, &mut device, total_size, &progress_tx)
        })();

        verified.map_err(|e| match e {
            Error::VerificationFailed(_) | Error::DriveDisconnected => e,
            other => Error::VerificationFailed(other.to_string()),
        })?;
    }

    Ok(())
}

/// Best-effort: drop the kernel page cache for the whole device so a
/// subsequent read-back hits the physical medium instead of the copy we
/// just wrote. Failures are advisory and ignored.
fn drop_device_cache(device: &File) {
    use std::os::fd::AsRawFd;
    // SAFETY: `device` owns the fd and keeps it open for this call. A `len`
    // of 0 means "to end of file"; the return value is purely advisory.
    unsafe {
        libc::posix_fadvise(device.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED);
    }
}

/// Unmount everything on the device before writing.
async fn unmount_device(conn: &Connection, block_path: &OwnedObjectPath) -> Result<()> {
    let mut targets = vec![block_path.clone()];
    // Unpartitioned media has no PartitionTable interface; the property
    // read fails and only the whole-disk filesystem is unmounted.
    if let Ok(builder) = UDisks2PartitionTableProxy::builder(conn).path(block_path.clone()) {
        if let Ok(table) = builder.cache_properties(CacheProperties::No).build().await {
            if let Ok(partitions) = table.partitions().await {
                targets.extend(partitions);
            }
        }
    }

    for path in targets {
        let builder = match UDisks2FilesystemProxy::builder(conn).path(path) {
            Ok(builder) => builder,
            Err(_) => continue,
        };
        let proxy = match builder.cache_properties(CacheProperties::No).build().await {
            Ok(proxy) => proxy,
            Err(_) => continue,
        };
        let mut options = HashMap::new();
        options.insert("force", Value::from(true));
        if let Err(e) = proxy.unmount(options).await {
            if let err @ (Error::PermissionDenied(_) | Error::DiskServiceUnavailable(_)) =
                map_udisks_error(e, "unmounting a volume")
            {
                return Err(err);
            }
        }
    }

    Ok(())
}

fn write_to_device(
    image_path: &PathBuf,
    dest: &mut File,
    total_size: u64,
    progress_tx: &mpsc::Sender<ProgressUpdate>,
) -> Result<()> {
    let mut source = File::open(image_path)?;

    let mut buffer = vec![0u8; WRITE_BUFFER_SIZE];
    let mut bytes_written: u64 = 0;
    let mut last_progress_bytes: u64 = 0;

    loop {
        let bytes_read = source.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }

        dest.write_all(&buffer[..bytes_read]).map_err(|e| {
            if is_drive_disconnected(&e) {
                Error::DriveDisconnected
            } else {
                Error::Io(e)
            }
        })?;

        bytes_written += bytes_read as u64;

        // Update progress periodically
        if bytes_written - last_progress_bytes >= PROGRESS_UPDATE_INTERVAL {
            last_progress_bytes = bytes_written;
            let _ = progress_tx.send(ProgressUpdate {
                stage: FlashStage::Writing,
                bytes_processed: bytes_written,
                total_bytes: total_size,
                message: "Writing image to device...".to_string(),
            });
        }
    }

    dest.sync_all().map_err(|e| {
        if is_drive_disconnected(&e) {
            Error::DriveDisconnected
        } else {
            Error::Io(e)
        }
    })?;

    // Send final progress
    let _ = progress_tx.send(ProgressUpdate {
        stage: FlashStage::Writing,
        bytes_processed: bytes_written,
        total_bytes: total_size,
        message: "Write complete".to_string(),
    });

    Ok(())
}

fn verify_write(
    image_path: &PathBuf,
    dest: &mut File,
    total_size: u64,
    progress_tx: &mpsc::Sender<ProgressUpdate>,
) -> Result<()> {
    let mut source = File::open(image_path)?;

    let mut source_buffer = vec![0u8; WRITE_BUFFER_SIZE];
    let mut dest_buffer = vec![0u8; WRITE_BUFFER_SIZE];
    let mut bytes_verified: u64 = 0;
    let mut last_progress_bytes: u64 = 0;

    loop {
        let source_read = source.read(&mut source_buffer)?;
        if source_read == 0 {
            break;
        }

        dest.read_exact(&mut dest_buffer[..source_read])
            .map_err(|e| {
                if is_drive_disconnected(&e) {
                    Error::DriveDisconnected
                } else {
                    Error::Io(e)
                }
            })?;

        if source_buffer[..source_read] != dest_buffer[..source_read] {
            return Err(Error::VerificationFailed(
                "Data mismatch during verification".to_string(),
            ));
        }

        bytes_verified += source_read as u64;

        // Update progress periodically
        if bytes_verified - last_progress_bytes >= PROGRESS_UPDATE_INTERVAL {
            last_progress_bytes = bytes_verified;
            let _ = progress_tx.send(ProgressUpdate {
                stage: FlashStage::Verifying,
                bytes_processed: bytes_verified,
                total_bytes: total_size,
                message: "Verifying written data...".to_string(),
            });
        }
    }

    // Send final progress
    let _ = progress_tx.send(ProgressUpdate {
        stage: FlashStage::Verifying,
        bytes_processed: bytes_verified,
        total_bytes: total_size,
        message: "Verification complete".to_string(),
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zbus::message::Message;
    use zbus::names::OwnedErrorName;

    #[test]
    fn test_parse_lsblk_removable_flags() {
        let removable = br#"{"blockdevices": [{"rm": true, "hotplug": false}]}"#;
        assert!(parse_lsblk_removable(removable));

        // USB/MMC disks often report rm=false but hotplug=true.
        let hotplug = br#"{"blockdevices": [{"rm": false, "hotplug": true}]}"#;
        assert!(parse_lsblk_removable(hotplug));

        let internal = br#"{"blockdevices": [{"rm": false, "hotplug": false}]}"#;
        assert!(!parse_lsblk_removable(internal));
    }

    #[test]
    fn test_parse_lsblk_removable_degenerate_output() {
        assert!(!parse_lsblk_removable(br#"{"blockdevices": []}"#));
        assert!(!parse_lsblk_removable(br#"{"blockdevices": [{}]}"#));
        assert!(!parse_lsblk_removable(b"not json"));
    }

    #[test]
    fn test_is_removable_or_hotplug_blocks_unknown_device() {
        assert!(!is_removable_or_hotplug("/dev/hai-test-nonexistent"));
    }

    fn method_error(name: &str, message: Option<&str>) -> zbus::Error {
        let msg = Message::method_call("/", "Test")
            .unwrap()
            .build(&())
            .unwrap();
        zbus::Error::MethodError(
            OwnedErrorName::try_from(name).unwrap(),
            message.map(String::from),
            msg,
        )
    }

    #[test]
    fn test_map_udisks_error_service_unknown() {
        let err = method_error("org.freedesktop.DBus.Error.ServiceUnknown", None);
        let mapped = map_udisks_error(err, "resolving the device");
        assert!(matches!(mapped, Error::DiskServiceUnavailable(_)));
    }

    #[test]
    fn test_map_udisks_error_authorization_dismissed() {
        // Must match before the generic NotAuthorized branch, since the
        // name contains "NotAuthorized" as a prefix.
        let err = method_error(
            "org.freedesktop.UDisks2.Error.NotAuthorizedDismissed",
            Some("Not authorized to perform operation"),
        );
        let mapped = map_udisks_error(err, "opening the device");
        assert!(
            matches!(mapped, Error::PermissionDenied(msg) if msg == "Authorization was canceled")
        );
    }

    #[test]
    fn test_map_udisks_error_not_authorized_uses_message() {
        let err = method_error(
            "org.freedesktop.UDisks2.Error.NotAuthorizedCanObtain",
            Some("Not authorized to open the device"),
        );
        let mapped = map_udisks_error(err, "opening the device");
        assert!(
            matches!(mapped, Error::PermissionDenied(msg) if msg == "Not authorized to open the device")
        );
    }

    #[test]
    fn test_map_udisks_error_busy_from_failed_message() {
        let err = method_error(
            "org.freedesktop.UDisks2.Error.Failed",
            Some("Error opening device /dev/sdb: Device or resource busy"),
        );
        let mapped = map_udisks_error(err, "opening the device");
        assert!(matches!(mapped, Error::DeviceBusy(_)));
    }

    #[test]
    fn test_map_udisks_error_bus_unreachable() {
        let err = zbus::Error::Failure("could not connect".to_string());
        let mapped = map_udisks_error(err, "connecting to the system bus");
        assert!(matches!(mapped, Error::DiskServiceUnavailable(_)));
    }

    #[test]
    fn test_write_to_device_copies_image() {
        let data: Vec<u8> = (0..123_456u32).map(|i| (i % 251) as u8).collect();
        let image = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(image.path(), &data).unwrap();

        let mut dest = tempfile::tempfile().unwrap();
        let (tx, rx) = mpsc::channel();
        write_to_device(
            &image.path().to_path_buf(),
            &mut dest,
            data.len() as u64,
            &tx,
        )
        .unwrap();

        dest.seek(SeekFrom::Start(0)).unwrap();
        let mut written = Vec::new();
        dest.read_to_end(&mut written).unwrap();
        assert_eq!(written, data);

        let last = rx.try_iter().last().unwrap();
        assert_eq!(last.stage, FlashStage::Writing);
        assert_eq!(last.bytes_processed, data.len() as u64);
    }

    #[test]
    fn test_verify_write_detects_mismatch() {
        let image = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(image.path(), b"expected data").unwrap();

        let mut dest = tempfile::tempfile().unwrap();
        dest.write_all(b"corrupted data").unwrap();
        dest.seek(SeekFrom::Start(0)).unwrap();

        let (tx, _rx) = mpsc::channel();
        let result = verify_write(&image.path().to_path_buf(), &mut dest, 13, &tx);
        assert!(matches!(result, Err(Error::VerificationFailed(_))));
    }

    #[test]
    fn test_write_and_verify_roundtrip() {
        let data: Vec<u8> = (0..65_536u32).map(|i| (i % 199) as u8).collect();
        let image = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(image.path(), &data).unwrap();

        let device = tempfile::tempfile().unwrap();
        let (tx, rx) = mpsc::channel();
        write_and_verify(
            &image.path().to_path_buf(),
            device,
            data.len() as u64,
            true,
            tx,
        )
        .unwrap();

        let stages: Vec<FlashStage> = rx.try_iter().map(|u| u.stage).collect();
        assert!(stages.contains(&FlashStage::Writing));
        assert!(stages.contains(&FlashStage::Verifying));
    }
}
