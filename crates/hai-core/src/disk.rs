//! Block device enumeration and raw disk writing.
//!
//! This module provides platform-specific implementations for listing
//! block devices (SD cards, USB drives, etc.) and writing raw disk
//! images to them.

use crate::error::{Error, Result};
use crate::types::{BlockDevice, DeviceType, FlashProgress, FlashStage};
use crate::ProgressCallback;
use std::path::PathBuf;

#[cfg(target_os = "linux")]
#[path = "disk/linux/mod.rs"]
mod imp;
#[cfg(target_os = "macos")]
#[path = "disk/macos/mod.rs"]
mod imp;
#[cfg(target_os = "windows")]
#[path = "disk/windows/mod.rs"]
mod imp;

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
compile_error!("hai-core supports only Linux, macOS and Windows");

/// Buffer size for disk writes (4 MB for SD cards)
#[allow(dead_code)]
const WRITE_BUFFER_SIZE: usize = 4 * 1024 * 1024;

/// Buffer size for fast drives like NVMe/SSDs (64 MB)
#[allow(dead_code)]
const FAST_DRIVE_BUFFER_SIZE: usize = 64 * 1024 * 1024;

/// How often to send progress updates (every N bytes)
#[allow(dead_code)]
const PROGRESS_UPDATE_INTERVAL: u64 = 10 * 1024 * 1024; // 10 MB

/// Check if an I/O error indicates the drive was disconnected
fn is_drive_disconnected(io_err: &std::io::Error) -> bool {
    matches!(
        io_err.kind(),
        std::io::ErrorKind::NotFound
            | std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::UnexpectedEof
    ) || io_err.raw_os_error().is_some_and(|code| {
        // macOS: ENXIO (6) = "Device not configured"
        // Linux: ENODEV (19) = "No such device", ENXIO (6)
        matches!(code, 6 | 19)
    })
}

/// Drive a blocking task while forwarding its progress updates to the
/// callback, then drain updates buffered after the task finished (e.g. the
/// final "Write complete" / "Verification complete") so they aren't lost.
async fn run_with_progress<P: ProgressCallback>(
    handle: tokio::task::JoinHandle<Result<()>>,
    progress_rx: std::sync::mpsc::Receiver<FlashProgress>,
    progress_callback: &P,
) -> Result<()> {
    loop {
        match progress_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(update) => progress_callback.on_progress(update),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if handle.is_finished() {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    while let Ok(update) = progress_rx.try_recv() {
        progress_callback.on_progress(update);
    }

    handle
        .await
        .map_err(|e| Error::Io(std::io::Error::other(e)))?
}

/// List all available block devices on the system
///
/// Returns removable devices suitable for flashing (SD cards, USB drives, etc.)
/// Filters out internal and system drives for safety.
pub async fn list_devices() -> Result<Vec<BlockDevice>> {
    imp::list_devices().await
}

/// Write an image file to a block device with progress updates
pub async fn write_image<P: ProgressCallback>(
    image_path: &PathBuf,
    device_id: &str,
    verify: bool,
    progress_callback: &P,
) -> Result<()> {
    std::fs::metadata(image_path)?;

    imp::write_image(image_path, device_id, verify, progress_callback).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_drive_disconnected_all_matching_kinds() {
        use std::io::ErrorKind;

        for kind in [
            ErrorKind::NotFound,
            ErrorKind::BrokenPipe,
            ErrorKind::UnexpectedEof,
        ] {
            assert!(
                is_drive_disconnected(&std::io::Error::new(kind, "test")),
                "{kind:?} should be detected as disconnected"
            );
        }

        // Raw OS error codes: ENXIO (6) and ENODEV (19)
        for code in [6, 19] {
            assert!(
                is_drive_disconnected(&std::io::Error::from_raw_os_error(code)),
                "os error {code} should be detected as disconnected"
            );
        }
    }

    #[test]
    fn test_is_drive_disconnected_non_matching_kinds() {
        use std::io::ErrorKind;

        for kind in [
            ErrorKind::PermissionDenied,
            ErrorKind::ConnectionRefused,
            ErrorKind::ConnectionReset,
            ErrorKind::ConnectionAborted,
            ErrorKind::AddrInUse,
            ErrorKind::AddrNotAvailable,
            ErrorKind::InvalidInput,
            ErrorKind::InvalidData,
            ErrorKind::TimedOut,
            ErrorKind::WriteZero,
            ErrorKind::Interrupted,
            ErrorKind::Other,
            ErrorKind::WouldBlock,
        ] {
            assert!(
                !is_drive_disconnected(&std::io::Error::new(kind, "test")),
                "{kind:?} should NOT be detected as disconnected"
            );
        }

        // Non-matching raw OS error codes: EPERM (1) and EACCES (13)
        for code in [1, 13] {
            assert!(
                !is_drive_disconnected(&std::io::Error::from_raw_os_error(code)),
                "os error {code} should NOT be detected as disconnected"
            );
        }

        // Error without a raw OS error code
        let err = std::io::Error::new(ErrorKind::Other, "generic error");
        assert!(!is_drive_disconnected(&err));
    }

    #[tokio::test]
    async fn test_list_devices_succeeds() {
        // Smoke test: the real platform enumeration runs and succeeds.
        assert!(list_devices().await.is_ok());
    }

    #[tokio::test]
    async fn test_write_image_nonexistent_image() {
        // The image metadata check runs before any platform code, so a
        // missing image surfaces as Io and the device id is never touched.
        let image_path = PathBuf::from("/nonexistent/image/file.img");
        let result =
            write_image(&image_path, "unused-device-id", false, &crate::NoOpProgress).await;
        assert!(matches!(result.unwrap_err(), Error::Io(_)));
    }
}
