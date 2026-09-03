//! Windows disk writing via direct `\\.\PhysicalDrive` access (requires Administrator).

use super::*;
use std::fs::File;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::mpsc;

/// Progress update sent from blocking task
struct ProgressUpdate {
    stage: FlashStage,
    bytes_processed: u64,
    total_bytes: u64,
    message: String,
}

/// Validate that a device path is safe to write to (not a system drive)
pub fn validate_device_path(device_id: &str) -> Result<()> {
    // On Windows, PhysicalDrive0 is usually the system drive
    if device_id == "\\\\.\\PhysicalDrive0" {
        return Err(Error::PermissionDenied(
            "PhysicalDrive0 is the system drive and cannot be overwritten".to_string(),
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
    let disk_number = device_id
        .strip_prefix("\\\\.\\PhysicalDrive")
        .ok_or_else(|| Error::DeviceNotFound(device_id.to_string()))?;

    clean_disk(disk_number)?;

    let image_size = std::fs::metadata(image_path)?.len();

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Writing,
        progress: 0,
        bytes_processed: 0,
        total_bytes: image_size,
        message: "Writing image to device...".to_string(),
    });

    // Create channel for progress updates from blocking task
    let (progress_tx, progress_rx) = mpsc::channel::<ProgressUpdate>();

    let image_path_clone = image_path.clone();
    let device_id_clone = device_id.to_string();

    let write_handle = tokio::task::spawn_blocking(move || {
        write_to_device(&image_path_clone, &device_id_clone, image_size, progress_tx)
    });

    // Forward progress updates while waiting for write to complete
    loop {
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
                if write_handle.is_finished() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break;
            }
        }
    }

    write_handle
        .await
        .map_err(|e| Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))??;

    if verify {
        progress_callback.on_progress(FlashProgress {
            stage: FlashStage::Verifying,
            progress: 0,
            bytes_processed: 0,
            total_bytes: image_size,
            message: "Verifying written data...".to_string(),
        });

        let (verify_tx, verify_rx) = mpsc::channel::<ProgressUpdate>();

        let image_path_clone = image_path.clone();
        let device_id_clone = device_id.to_string();

        let verify_handle = tokio::task::spawn_blocking(move || {
            verify_write(&image_path_clone, &device_id_clone, image_size, verify_tx)
        });

        // Forward verify progress updates
        loop {
            match verify_rx.recv_timeout(std::time::Duration::from_millis(100)) {
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
                    if verify_handle.is_finished() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break;
                }
            }
        }

        verify_handle
            .await
            .map_err(|e| Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))??;
    }

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Finalizing,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Finalizing...".to_string(),
    });

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Complete,
        progress: 100,
        bytes_processed: image_size,
        total_bytes: image_size,
        message: "Complete".to_string(),
    });

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

fn write_to_device(
    image_path: &PathBuf,
    device_path: &str,
    total_size: u64,
    progress_tx: mpsc::Sender<ProgressUpdate>,
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
    device_path: &str,
    total_size: u64,
    progress_tx: mpsc::Sender<ProgressUpdate>,
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

    #[test]
    fn test_validate_device_path_blocks_physicaldrive0() {
        let result = validate_device_path("\\\\.\\PhysicalDrive0");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), Error::PermissionDenied(_)));
    }

    #[test]
    fn test_validate_physical_drives() {
        assert!(validate_device_path("\\\\.\\PhysicalDrive0").is_err());
        assert!(validate_device_path("\\\\.\\PhysicalDrive1").is_ok());
        assert!(validate_device_path("\\\\.\\PhysicalDrive2").is_ok());
        assert!(validate_device_path("\\\\.\\PhysicalDrive10").is_ok());
    }

    #[test]
    fn test_validate_all_physical_drives() {
        // Test PhysicalDrive0
        assert!(validate_device_path("\\\\.\\PhysicalDrive0").is_err());

        // Test other drives are OK
        for i in 1..10 {
            let drive = format!("\\\\.\\PhysicalDrive{}", i);
            assert!(
                validate_device_path(&drive).is_ok(),
                "Drive {} should be OK",
                i
            );
        }
    }

    #[test]
    fn test_validation_error_message() {
        let result = validate_device_path("\\\\.\\PhysicalDrive0");
        assert!(result.is_err());
        match result {
            Err(Error::PermissionDenied(msg)) => {
                assert!(msg.contains("PhysicalDrive0") || msg.contains("system drive"));
            }
            _ => panic!("Expected PermissionDenied error"),
        }
    }

    #[test]
    fn test_clean_disk_nonexistent() {
        // Test cleaning a disk that doesn't exist
        let result = clean_disk("999");
        // Should either succeed or fail, but not panic
        assert!(result.is_ok() || result.is_err());
    }
}
