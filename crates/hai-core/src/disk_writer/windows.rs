//! Windows disk writing via direct `\\.\PhysicalDrive` access (requires Administrator).

use super::*;
use std::fs::File;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::mpsc;

pub async fn write_image<P: ProgressCallback>(
    image_path: &PathBuf,
    device_id: &str,
    verify: bool,
    progress_callback: &P,
) -> Result<()> {
    let disk_number = device_id
        .strip_prefix("\\\\.\\PhysicalDrive")
        .ok_or_else(|| Error::DeviceNotFound(device_id.to_string()))?;

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

    let image_path_clone = image_path.clone();
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
    image_path: &PathBuf,
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

fn write_to_device(
    image_path: &PathBuf,
    device_path: &str,
    total_size: u64,
    progress_tx: &mpsc::Sender<FlashProgress>,
) -> Result<()> {
    let mut source = File::open(image_path)?;

    let mut dest = std::fs::OpenOptions::new()
        .write(true)
        .open(device_path)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                Error::PermissionDenied(
                    "Administrator access required. Please run as Administrator.".to_string(),
                )
            } else if is_drive_disconnected(&e) {
                Error::DriveDisconnected
            } else {
                Error::Io(e)
            }
        })?;

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
            let _ = progress_tx.send(FlashProgress::new(
                FlashStage::Writing,
                bytes_written,
                total_size,
                "Writing image to device...",
            ));
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
    let _ = progress_tx.send(FlashProgress::new(
        FlashStage::Writing,
        bytes_written,
        total_size,
        "Write complete",
    ));

    Ok(())
}

fn verify_write(
    image_path: &PathBuf,
    device_path: &str,
    total_size: u64,
    progress_tx: &mpsc::Sender<FlashProgress>,
) -> Result<()> {
    let mut source = File::open(image_path)?;
    let mut dest = File::open(device_path).map_err(|e| {
        if is_drive_disconnected(&e) {
            Error::DriveDisconnected
        } else {
            Error::Io(e)
        }
    })?;

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

fn clean_disk(disk_number: &str) -> Result<()> {
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

    #[tokio::test]
    #[serial]
    async fn test_write_image_invalid_device() {
        let temp_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(temp_file.path(), b"test data").unwrap();
        let image_path = temp_file.path().to_path_buf();

        // Fails at clean_disk: the device does not exist.
        let device_id = "\\\\.\\PhysicalDrive999";

        let result = write_image(&image_path, device_id, false, &crate::NoOpProgress).await;
        assert!(result.is_err());
    }
}
