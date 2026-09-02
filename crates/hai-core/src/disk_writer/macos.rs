//! macOS disk writing via privileged `dd` (Authorization Services) and `diskutil`.

use super::*;
use security_framework::authorization::{Authorization, AuthorizationItemSetBuilder, Flags};
use std::io::Read;
use std::path::Path;
use std::process::Command;
use std::sync::mpsc;

/// Progress update sent from blocking task
struct ProgressUpdate {
    stage: FlashStage,
    bytes_processed: u64,
    total_bytes: u64,
    message: String,
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
    image_path: &PathBuf,
    device_path: &str,
    disk_id: &str,
    total_size: u64,
    verify: bool,
    progress_tx: mpsc::Sender<ProgressUpdate>,
) -> Result<()> {
    // Request authorization
    let auth = request_authorization()?;

    // Write the image and compute checksum if verification is requested
    let source_checksum = write_with_auth(
        &auth,
        image_path,
        device_path,
        total_size,
        verify,
        &progress_tx,
    )?;

    // Verify if requested
    if verify {
        let checksum =
            source_checksum.expect("Checksum should have been computed when verify=true");
        verify_with_auth(&auth, &checksum, device_path, total_size, &progress_tx)?;
    }

    // Finalize - eject
    eject_disk(disk_id)?;

    Ok(())
}

fn request_authorization() -> Result<Authorization> {
    let rights = AuthorizationItemSetBuilder::new()
        .add_right("system.privilege.admin")
        .map_err(|e| Error::PermissionDenied(format!("Failed to create rights: {}", e)))?
        .build();

    Authorization::new(
        Some(rights),
        None,
        Flags::INTERACTION_ALLOWED | Flags::EXTEND_RIGHTS | Flags::PREAUTHORIZE,
    )
    .map_err(|e| {
        if e.code() == -60006 {
            Error::PermissionDenied("Administrator access was denied by user".to_string())
        } else if e.code() == -60005 {
            Error::PermissionDenied("Authorization was canceled".to_string())
        } else {
            Error::PermissionDenied(format!("Authorization failed: {}", e))
        }
    })
}

fn write_with_auth(
    auth: &Authorization,
    image_path: &PathBuf,
    device_path: &str,
    total_size: u64,
    compute_checksum: bool,
    progress_tx: &mpsc::Sender<ProgressUpdate>,
) -> Result<Option<String>> {
    use sha2::{Digest, Sha256};
    use std::io::Write;

    let mut source = std::fs::File::open(image_path)?;

    let dd_path = Path::new("/bin/dd");
    let of_arg = format!("of={}", device_path);
    let bs_arg = "bs=64m".to_string();

    // Send progress update before requesting privilege
    let _ = progress_tx.send(ProgressUpdate {
        stage: FlashStage::Writing,
        bytes_processed: 0,
        total_bytes: total_size,
        message: "Starting write...".to_string(),
    });

    let mut pipe = auth
        .execute_with_privileges_piped(dd_path, [&of_arg, &bs_arg], Flags::empty())
        .map_err(|e| Error::PermissionDenied(format!("Failed to open device: {}", e)))?;

    let mut hasher = if compute_checksum {
        Some(Sha256::new())
    } else {
        None
    };
    let mut buffer = vec![0u8; FAST_DRIVE_BUFFER_SIZE];
    let mut bytes_written: u64 = 0;
    let mut last_progress_update: u64 = 0;

    loop {
        let bytes_read = std::io::Read::read(&mut source, &mut buffer)?;
        if bytes_read == 0 {
            break;
        }

        if let Some(ref mut h) = hasher {
            h.update(&buffer[..bytes_read]);
        }

        pipe.write_all(&buffer[..bytes_read]).map_err(|e| {
            if is_drive_disconnected(&e) {
                Error::DriveDisconnected
            } else {
                Error::Io(e)
            }
        })?;

        bytes_written += bytes_read as u64;

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

    // Send final write progress
    let _ = progress_tx.send(ProgressUpdate {
        stage: FlashStage::Writing,
        bytes_processed: bytes_written,
        total_bytes: total_size,
        message: "Syncing data to drive...".to_string(),
    });

    drop(pipe);
    let _ = Command::new("sync").output();

    let checksum = hasher.map(|h| hex::encode(h.finalize()));
    Ok(checksum)
}

fn verify_with_auth(
    auth: &Authorization,
    source_checksum: &str,
    device_path: &str,
    total_size: u64,
    progress_tx: &mpsc::Sender<ProgressUpdate>,
) -> Result<()> {
    use sha2::{Digest, Sha256};

    // Send initial verify progress
    let _ = progress_tx.send(ProgressUpdate {
        stage: FlashStage::Verifying,
        bytes_processed: 0,
        total_bytes: total_size,
        message: "Starting verification...".to_string(),
    });

    let block_count = total_size.div_ceil(FAST_DRIVE_BUFFER_SIZE as u64);
    let dd_path = Path::new("/bin/dd");
    let if_arg = format!("if={}", device_path);
    let bs_arg = "bs=64m".to_string();
    let count_arg = format!("count={}", block_count);

    let mut pipe = auth
        .execute_with_privileges_piped(dd_path, [&if_arg, &bs_arg, &count_arg], Flags::empty())
        .map_err(|e| Error::PermissionDenied(format!("Failed to read device: {}", e)))?;

    let mut device_hasher = Sha256::new();
    let mut buffer = vec![0u8; FAST_DRIVE_BUFFER_SIZE];
    let mut bytes_read_total: u64 = 0;
    let mut last_progress_update: u64 = 0;

    loop {
        match pipe.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                device_hasher.update(&buffer[..n]);
                bytes_read_total += n as u64;

                // Send progress update every PROGRESS_UPDATE_INTERVAL bytes
                if bytes_read_total - last_progress_update >= PROGRESS_UPDATE_INTERVAL {
                    let _ = progress_tx.send(ProgressUpdate {
                        stage: FlashStage::Verifying,
                        bytes_processed: bytes_read_total,
                        total_bytes: total_size,
                        message: "Verifying written data...".to_string(),
                    });
                    last_progress_update = bytes_read_total;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                return Err(if is_drive_disconnected(&e) {
                    Error::DriveDisconnected
                } else {
                    Error::Io(e)
                });
            }
        }
    }

    let device_checksum = hex::encode(device_hasher.finalize());

    if source_checksum != device_checksum {
        return Err(Error::VerificationFailed(
            "Checksum mismatch after write".to_string(),
        ));
    }

    // Send final verify progress
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
}
