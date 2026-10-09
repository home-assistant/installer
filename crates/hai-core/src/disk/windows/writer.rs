//! Windows disk writing via direct physical-drive access (requires Administrator).

use super::super::*;
use super::volumes::{control, disk_length, lock_disk_volumes, refresh_properties};
use std::fs::File;
use std::os::windows::fs::OpenOptionsExt;
use std::sync::mpsc;
use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
use windows_sys::Win32::System::Ioctl::IOCTL_DISK_IS_WRITABLE;

pub async fn write_image<P: ProgressCallback>(
    image_path: &Path,
    device_id: &str,
    expected: &ExpectedDevice,
    verify: bool,
    progress_callback: &P,
) -> Result<()> {
    let disk_number = parse_disk_number(device_id)?;
    check_identity(&super::device::list_devices_sync()?, device_id, expected)?;
    let mut source = File::open(image_path)?;
    let image_size = source.metadata()?.len();
    // Keep this exact handle for clearing, writing, verification and refresh.
    let mut device = open_device_for_write(device_id)?;
    // The serial is read from the handle we write through, so a different
    // drive that took over this disk number is refused.
    check_handle_serial(&device, expected)?;
    ensure_media_writable(&device)?;

    progress_callback.on_progress(FlashProgress::new(
        FlashStage::Writing,
        0,
        image_size,
        "Writing image to device...",
    ));
    let (progress_tx, progress_rx) = mpsc::channel::<FlashProgress>();
    let write_handle = tokio::task::spawn_blocking(move || {
        let disk_size = disk_length(&device)?;
        windows_transfer::validate_sizes(image_size, disk_size)?;
        let volumes = lock_disk_volumes(disk_number)?;
        windows_transfer::with_volume_locks(
            &mut device,
            volumes,
            |device| {
                windows_transfer::transfer(
                    &mut source,
                    device,
                    image_size,
                    disk_size,
                    verify,
                    &progress_tx,
                )?;
                let _ = progress_tx.send(FlashProgress::new(
                    FlashStage::Finalizing,
                    0,
                    0,
                    "Finalizing...",
                ));
                Ok(())
            },
            refresh_properties,
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

fn open_device_for_write(device_path: &str) -> Result<File> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(device_path)
        .map_err(|error| {
            if is_write_protected(&error) {
                Error::WriteProtected
            } else if error.kind() == std::io::ErrorKind::PermissionDenied {
                Error::PermissionDenied(
                    "Administrator access required. Please run as Administrator.".into(),
                )
            } else {
                device_io_error(error)
            }
        })
}

fn check_handle_serial(device: &File, expected: &ExpectedDevice) -> Result<()> {
    // A known serial must match exactly (apart from surrounding whitespace):
    // do not silently fall back when a driver omits or changes it.
    let Some(expected_serial) = &expected.serial else {
        return Ok(());
    };
    let serial = crate::disk::windows_serial::read_serial(device)?;
    if serial.as_ref() != Some(expected_serial) {
        return Err(Error::DeviceNotFound(
            "The selected drive's serial changed or is unavailable. Select it again.".into(),
        ));
    }
    Ok(())
}

/// Unsupported writability probes are left for the actual write to report.
fn ensure_media_writable(device: &File) -> Result<()> {
    match control(device, IOCTL_DISK_IS_WRITABLE) {
        Err(error) if is_write_protected(&error) => Err(Error::WriteProtected),
        Err(error) if is_drive_disconnected(&error) => Err(Error::DriveDisconnected),
        _ => Ok(()),
    }
}

fn parse_disk_number(device_id: &str) -> Result<u32> {
    device_id
        .strip_prefix("\\\\.\\PhysicalDrive")
        .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|n| n.parse().ok())
        .ok_or_else(|| Error::DeviceNotFound(device_id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ensure_media_writable_lets_a_non_disk_through() {
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
            assert!(matches!(
                parse_disk_number(device_id),
                Err(Error::DeviceNotFound(_))
            ));
        }
    }

    #[tokio::test]
    async fn test_rejects_non_numeric_disk_number() {
        let image = tempfile::NamedTempFile::new().unwrap();
        let result = write_image(
            image.path(),
            "\\\\.\\PhysicalDrive1; echo injected",
            &ExpectedDevice::default(),
            false,
            &crate::NoOpProgress,
        )
        .await;
        assert!(matches!(result, Err(Error::DeviceNotFound(_))));
    }

    #[test]
    fn test_property_refresh_failure_is_not_success() {
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(refresh_properties(file.as_file()).is_err());
    }
}
