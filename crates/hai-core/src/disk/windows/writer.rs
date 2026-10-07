//! Windows disk writing via direct `\\.\PhysicalDrive` access (requires Administrator).

use super::super::*;
use std::fs::File;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::mpsc;

pub async fn write_image<P: ProgressCallback>(
    image_path: &Path,
    device_id: &str,
    verify: bool,
    progress_callback: &P,
) -> Result<()> {
    let disk_number = parse_disk_number(device_id)?;

    // Clear-Disk is destructive, so make sure the device can be opened for
    // writing (e.g. we are running as Administrator) and its media accepts
    // writes before wiping it.
    let probe = open_device_for_write(device_id)?;
    ensure_media_writable(&probe)?;
    drop(probe);

    clean_disk(disk_number)?;

    let image_size = std::fs::metadata(image_path)?.len();

    progress_callback.on_progress(FlashProgress::new(
        FlashStage::Writing,
        0,
        image_size,
        "Writing image to device...",
    ));

    // Send progress updates from the blocking task through a channel.
    let (progress_tx, progress_rx) = mpsc::channel::<FlashProgress>();

    let image_path_clone = image_path.to_path_buf();
    let device_id_clone = device_id.to_string();

    let write_handle = tokio::task::spawn_blocking(move || {
        write_and_verify(
            &image_path_clone,
            &device_id_clone,
            image_size,
            verify,
            progress_tx,
        )
    });

    run_with_progress(write_handle, progress_rx, progress_callback).await?;

    progress_callback.on_progress(FlashProgress::new(
        FlashStage::Finalizing,
        0,
        0,
        "Finalizing...",
    ));

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
    total_size: u64,
    verify: bool,
    progress_tx: mpsc::Sender<FlashProgress>,
) -> Result<()> {
    write_to_device(image_path, device_path, total_size, &progress_tx)?;

    if verify {
        let _ = progress_tx.send(FlashProgress::new(
            FlashStage::Verifying,
            0,
            total_size,
            "Verifying written data...",
        ));

        // Tag verify-phase failures as VerificationFailed so the caller can
        // label them "Verification failed" rather than "Write failed".
        verify_write(image_path, device_path, total_size, &progress_tx).map_err(|e| match e {
            Error::VerificationFailed(_) | Error::DriveDisconnected => e,
            other => Error::VerificationFailed(other.to_string()),
        })?;
    }

    Ok(())
}

fn open_device_for_write(device_path: &str) -> Result<File> {
    std::fs::OpenOptions::new()
        .write(true)
        .open(device_path)
        .map_err(|e| {
            // Before the permission check, so a locked card never gets the
            // advice to run as Administrator.
            if is_write_protected(&e) {
                Error::WriteProtected
            } else if e.kind() == std::io::ErrorKind::PermissionDenied {
                Error::PermissionDenied(
                    "Administrator access required. Please run as Administrator.".to_string(),
                )
            } else {
                device_io_error(e)
            }
        })
}

/// Ask the disk driver whether the media accepts writes. A write handle opens
/// fine on an SD card with its lock switch on; only a write, or this ioctl,
/// tells. A disconnect is reported right away; any other failure, like a
/// driver without this ioctl, is left for the write itself to report.
fn ensure_media_writable(device: &File) -> Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Ioctl::IOCTL_DISK_IS_WRITABLE;
    use windows_sys::Win32::System::IO::DeviceIoControl;

    let mut returned = 0u32;
    // SAFETY: the handle stays valid for the duration of the call, since
    // `device` owns it, and this ioctl takes no input or output buffers.
    let ok = unsafe {
        DeviceIoControl(
            device.as_raw_handle(),
            IOCTL_DISK_IS_WRITABLE,
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    if ok != 0 {
        return Ok(());
    }

    let err = std::io::Error::last_os_error();
    if is_write_protected(&err) {
        Err(Error::WriteProtected)
    } else if is_drive_disconnected(&err) {
        // Gone already; Clear-Disk would only fail with a less useful error
        Err(Error::DriveDisconnected)
    } else {
        Ok(())
    }
}

fn write_to_device(
    image_path: &Path,
    device_path: &str,
    total_size: u64,
    progress_tx: &mpsc::Sender<FlashProgress>,
) -> Result<()> {
    let mut source = File::open(image_path)?;

    let mut dest = open_device_for_write(device_path)?;

    let mut buffer = vec![0u8; WRITE_BUFFER_SIZE];
    let mut bytes_written: u64 = 0;
    let mut last_progress_bytes: u64 = 0;

    loop {
        let bytes_read = source.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }

        dest.write_all(&buffer[..bytes_read])
            .map_err(device_io_error)?;

        bytes_written += bytes_read as u64;

        // Update progress periodically
        if bytes_written - last_progress_bytes >= PROGRESS_UPDATE_INTERVAL {
            last_progress_bytes = bytes_written;
            let _ = progress_tx.send(FlashProgress::new(
                FlashStage::Writing,
                bytes_written,
                total_size,
                "Writing image to device...",
            ));
        }
    }

    dest.sync_all().map_err(device_io_error)?;

    // Send final progress
    let _ = progress_tx.send(FlashProgress::new(
        FlashStage::Writing,
        bytes_written,
        total_size,
        "Write complete",
    ));

    Ok(())
}

fn verify_write(
    image_path: &Path,
    device_path: &str,
    total_size: u64,
    progress_tx: &mpsc::Sender<FlashProgress>,
) -> Result<()> {
    let mut source = File::open(image_path)?;
    let mut dest = File::open(device_path).map_err(device_io_error)?;

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
            .map_err(device_io_error)?;

        if source_buffer[..source_read] != dest_buffer[..source_read] {
            return Err(Error::VerificationFailed(
                "Data mismatch during verification".to_string(),
            ));
        }

        bytes_verified += source_read as u64;

        // Update progress periodically
        if bytes_verified - last_progress_bytes >= PROGRESS_UPDATE_INTERVAL {
            last_progress_bytes = bytes_verified;
            let _ = progress_tx.send(FlashProgress::new(
                FlashStage::Verifying,
                bytes_verified,
                total_size,
                "Verifying written data...",
            ));
        }
    }

    // Send final progress
    let _ = progress_tx.send(FlashProgress::new(
        FlashStage::Verifying,
        bytes_verified,
        total_size,
        "Verification complete",
    ));

    Ok(())
}

/// Extract the disk number from a `\\.\PhysicalDriveN` device id.
///
/// The number is interpolated into a PowerShell command, so it must be
/// parsed as an integer rather than passed through as a string.
fn parse_disk_number(device_id: &str) -> Result<u32> {
    device_id
        .strip_prefix("\\\\.\\PhysicalDrive")
        .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|n| n.parse().ok())
        .ok_or_else(|| Error::DeviceNotFound(device_id.to_string()))
}

fn clean_disk(disk_number: u32) -> Result<()> {
    let ps_script = format!(
        "Clear-Disk -Number {} -RemoveData -RemoveOEM -Confirm:$false",
        disk_number
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_script])
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("not found") && !stderr.contains("no media") {
            return Err(Error::DeviceBusy(stderr.to_string()));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn test_ensure_media_writable_lets_a_non_disk_through() {
        // A regular file doesn't support the disk ioctl; that is not a
        // reason to refuse, only write protection is.
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(ensure_media_writable(file.as_file()).is_ok());
    }

    #[test]
    fn test_parse_disk_number_valid() {
        assert_eq!(parse_disk_number("\\\\.\\PhysicalDrive0").unwrap(), 0);
        assert_eq!(parse_disk_number("\\\\.\\PhysicalDrive12").unwrap(), 12);
    }

    #[test]
    fn test_parse_disk_number_rejects_non_numeric() {
        for device_id in [
            "\\\\.\\PhysicalDrive",
            "\\\\.\\PhysicalDrive1; Remove-Item C:\\ -Recurse",
            "\\\\.\\PhysicalDrive1 ",
            "\\\\.\\PhysicalDrive+1",
            "\\\\.\\PhysicalDrive-1",
            "\\\\.\\PhysicalDrive99999999999",
            "PhysicalDrive1",
            "C:",
        ] {
            assert!(
                matches!(parse_disk_number(device_id), Err(Error::DeviceNotFound(_))),
                "{device_id:?} should be rejected"
            );
        }
    }

    #[tokio::test]
    #[serial]
    async fn test_rejects_non_numeric_disk_number() {
        let temp_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(temp_file.path(), b"test data").unwrap();
        let image_path = temp_file.path().to_path_buf();

        // Must fail before any PowerShell command runs.
        let device_id = "\\\\.\\PhysicalDrive1; echo injected";

        let result = write_image(&image_path, device_id, false, &crate::NoOpProgress).await;
        assert!(matches!(result, Err(Error::DeviceNotFound(_))));
    }

    #[tokio::test]
    #[serial]
    async fn test_write_image_invalid_device() {
        let temp_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(temp_file.path(), b"test data").unwrap();
        let image_path = temp_file.path().to_path_buf();

        // Fails at the writability check: the device does not exist.
        let device_id = "\\\\.\\PhysicalDrive999";

        let result = write_image(&image_path, device_id, false, &crate::NoOpProgress).await;
        assert!(result.is_err());
    }
}
