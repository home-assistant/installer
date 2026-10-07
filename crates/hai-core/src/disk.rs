//! Block device enumeration and raw disk writing.
//!
//! This module provides platform-specific implementations for listing
//! block devices (SD cards, USB drives, etc.) and writing raw disk
//! images to them.

use crate::error::{Error, Result};
use crate::types::{BlockDevice, DeviceType, FlashProgress, FlashStage};
use crate::{Backend, DeviceBackend, ProgressCallback};
use std::path::Path;

#[cfg(target_os = "linux")]
#[path = "disk/linux/mod.rs"]
mod imp;
#[cfg(target_os = "macos")]
#[path = "disk/macos/mod.rs"]
mod imp;
#[cfg(target_os = "windows")]
#[path = "disk/windows/mod.rs"]
mod imp;

// Pure logic behind the macOS write path, compiled under `test` on every
// platform so the Linux-only backend test job covers it without shipping it
// in non-macOS builds.
#[cfg(any(target_os = "macos", test))]
#[path = "disk/macos/logic.rs"]
mod macos_logic;

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

/// Whether a media type/model string refers to an SD card. Matches "SD" as
/// its own word (plus SDHC/SDXC/microSD variants) so names like "Samsung
/// Portable SSD" don't count.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn mentions_sd_card(s: &str) -> bool {
    let s = s.to_lowercase();
    s.split(|c: char| !c.is_ascii_alphanumeric()).any(|token| {
        matches!(
            token,
            "sd" | "sdhc" | "sdxc" | "microsd" | "microsdhc" | "microsdxc"
        )
    })
}

/// Raw OS error codes that mean the drive went away. The numbers differ per
/// OS: on Windows 6 is `ERROR_INVALID_HANDLE` and 19 `ERROR_WRITE_PROTECT`.
#[cfg(unix)]
const DISCONNECTED_OS_ERRORS: &[i32] = &[
    6,  // ENXIO: device not configured
    19, // ENODEV: no such device
];
#[cfg(windows)]
const DISCONNECTED_OS_ERRORS: &[i32] = &[
    21,   // ERROR_NOT_READY
    433,  // ERROR_NO_SUCH_DEVICE
    1167, // ERROR_DEVICE_NOT_CONNECTED
];

/// Raw OS error codes that mean the drive refuses writes.
#[cfg(unix)]
const WRITE_PROTECTED_OS_ERRORS: &[i32] = &[
    30, // EROFS: read-only file system
];
#[cfg(windows)]
const WRITE_PROTECTED_OS_ERRORS: &[i32] = &[
    19, // ERROR_WRITE_PROTECT
];

/// Check if an I/O error indicates the drive was disconnected
fn is_drive_disconnected(io_err: &std::io::Error) -> bool {
    matches!(
        io_err.kind(),
        std::io::ErrorKind::NotFound
            | std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::UnexpectedEof
    ) || io_err
        .raw_os_error()
        .is_some_and(|code| DISCONNECTED_OS_ERRORS.contains(&code))
}

/// Check if an I/O error means the drive is write-protected, like an SD card
/// with its lock switch on.
fn is_write_protected(io_err: &std::io::Error) -> bool {
    io_err.kind() == std::io::ErrorKind::ReadOnlyFilesystem
        || io_err
            .raw_os_error()
            .is_some_and(|code| WRITE_PROTECTED_OS_ERRORS.contains(&code))
}

/// Map an I/O error from reading or writing the device onto an [`Error`]:
/// a disconnect and write protection get their own errors, so the user is
/// told what to do about them.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn device_io_error(io_err: std::io::Error) -> Error {
    if is_drive_disconnected(&io_err) {
        Error::DriveDisconnected
    } else if is_write_protected(&io_err) {
        Error::WriteProtected
    } else {
        Error::Io(io_err)
    }
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

/// List all block devices on the system
async fn list_devices() -> Result<Vec<BlockDevice>> {
    imp::list_devices().await
}

/// Write an image file to a block device with progress updates
async fn write_image<P: ProgressCallback>(
    image_path: &Path,
    device_id: &str,
    verify: bool,
    progress_callback: &P,
) -> Result<()> {
    std::fs::metadata(image_path)?;

    imp::write_image(image_path, device_id, verify, progress_callback).await
}

impl DeviceBackend for Backend {
    async fn list_devices(&self) -> Result<Vec<BlockDevice>> {
        list_devices().await
    }

    async fn write_image<P: ProgressCallback>(
        &self,
        image_path: &Path,
        device_id: &str,
        verify: bool,
        progress_callback: &P,
    ) -> Result<()> {
        write_image(image_path, device_id, verify, progress_callback).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn test_mentions_sd_card_whole_word_variants() {
        for s in [
            "SD",
            "sd card",
            "SD Card Reader",
            "SDXC",
            "SDHC Card",
            "microSD",
            "microSDHC",
            "SanDisk Extreme microSDXC",
            "Generic-SD/MMC",
            "APPLE SD Card Reader Media",
        ] {
            assert!(mentions_sd_card(s), "{s:?} should be an SD card");
        }
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn test_mentions_sd_card_rejects_substrings() {
        for s in [
            "",
            "SSD",
            "Samsung Portable SSD T7",
            "USB Drive",
            "sdb",
            "sda1",
        ] {
            assert!(!mentions_sd_card(s), "{s:?} should not be an SD card");
        }
    }

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

        for &code in DISCONNECTED_OS_ERRORS {
            assert!(
                is_drive_disconnected(&std::io::Error::from_raw_os_error(code)),
                "os error {code} should be detected as disconnected"
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn test_unix_disconnect_codes() {
        // ENXIO and ENODEV
        for code in [6, 19] {
            assert!(is_drive_disconnected(&std::io::Error::from_raw_os_error(
                code
            )));
        }
    }

    /// The Unix numbers mean something else on Windows: 6 is
    /// ERROR_INVALID_HANDLE and 19 ERROR_WRITE_PROTECT, a locked SD card.
    #[test]
    #[cfg(windows)]
    fn test_windows_disconnect_codes() {
        for code in [21, 433, 1167] {
            assert!(
                is_drive_disconnected(&std::io::Error::from_raw_os_error(code)),
                "os error {code} should be detected as disconnected"
            );
        }
        for code in [6, 19] {
            assert!(
                !is_drive_disconnected(&std::io::Error::from_raw_os_error(code)),
                "os error {code} should NOT be detected as disconnected"
            );
        }
    }

    #[test]
    fn test_is_write_protected() {
        assert!(is_write_protected(&std::io::Error::new(
            std::io::ErrorKind::ReadOnlyFilesystem,
            "test"
        )));

        #[cfg(unix)]
        let locked = 30; // EROFS
        #[cfg(windows)]
        let locked = 19; // ERROR_WRITE_PROTECT
        assert!(is_write_protected(&std::io::Error::from_raw_os_error(
            locked
        )));
        assert!(!is_drive_disconnected(&std::io::Error::from_raw_os_error(
            locked
        )));

        assert!(!is_write_protected(&std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "test"
        )));
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    fn test_device_io_error_maps_disconnect_and_write_protection() {
        use std::io::{Error as IoError, ErrorKind};

        assert!(matches!(
            device_io_error(IoError::new(ErrorKind::BrokenPipe, "gone")),
            Error::DriveDisconnected
        ));
        assert!(matches!(
            device_io_error(IoError::new(ErrorKind::ReadOnlyFilesystem, "locked")),
            Error::WriteProtected
        ));
        assert!(matches!(
            device_io_error(IoError::other("something else")),
            Error::Io(_)
        ));
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

        // Non-matching raw OS error codes: EPERM / ERROR_INVALID_FUNCTION (1)
        // and EACCES / ERROR_INVALID_DATA (13)
        for code in [1, 13] {
            assert!(
                !is_drive_disconnected(&std::io::Error::from_raw_os_error(code)),
                "os error {code} should NOT be detected as disconnected"
            );
        }

        // Error without a raw OS error code
        let err = std::io::Error::other("generic error");
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
        let image_path = Path::new("/nonexistent/image/file.img");
        let result = write_image(image_path, "unused-device-id", false, &crate::NoOpProgress).await;
        assert!(matches!(result.unwrap_err(), Error::Io(_)));
    }
}
