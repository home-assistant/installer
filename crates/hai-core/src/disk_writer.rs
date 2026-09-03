//! Raw disk writing functionality for flashing images to devices.
//!
//! This module provides platform-specific implementations for writing
//! raw disk images to block devices (SD cards, USB drives, etc.).

use crate::error::{Error, Result};
use crate::types::{FlashProgress, FlashStage};
use crate::ProgressCallback;
use std::path::PathBuf;

#[cfg(target_os = "linux")]
#[path = "disk_writer/linux.rs"]
mod imp;
#[cfg(target_os = "macos")]
#[path = "disk_writer/macos.rs"]
mod imp;
#[cfg(target_os = "windows")]
#[path = "disk_writer/windows.rs"]
mod imp;

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod imp {
    use super::*;

    pub async fn write_image<P: ProgressCallback>(
        _image_path: &PathBuf,
        _device_id: &str,
        _verify: bool,
        _progress_callback: &P,
    ) -> Result<()> {
        Err(Error::UnsupportedPlatform("Disk writing".to_string()))
    }
}

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
    use serial_test::serial;

    #[test]
    fn test_is_drive_disconnected_not_found() {
        let err = std::io::Error::new(std::io::ErrorKind::NotFound, "device not found");
        assert!(is_drive_disconnected(&err));
    }

    #[test]
    fn test_is_drive_disconnected_broken_pipe() {
        let err = std::io::Error::new(std::io::ErrorKind::BrokenPipe, "pipe broken");
        assert!(is_drive_disconnected(&err));
    }

    #[test]
    fn test_is_drive_disconnected_permission_denied_is_not_disconnect() {
        let err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied");
        assert!(!is_drive_disconnected(&err));
    }

    #[test]
    fn test_is_drive_disconnected_unexpected_eof() {
        let err = std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "unexpected eof");
        assert!(is_drive_disconnected(&err));
    }

    #[test]
    fn test_is_drive_disconnected_other_error_kinds() {
        let err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "permission denied");
        assert!(!is_drive_disconnected(&err));

        let err = std::io::Error::new(std::io::ErrorKind::Other, "other error");
        assert!(!is_drive_disconnected(&err));
    }

    #[test]
    fn test_is_drive_disconnected_with_os_error_code_6() {
        // ENXIO = 6 on macOS and Linux
        let err = std::io::Error::from_raw_os_error(6);
        assert!(is_drive_disconnected(&err));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn test_is_drive_disconnected_with_os_error_code_19() {
        // ENODEV = 19 on Linux
        let err = std::io::Error::from_raw_os_error(19);
        assert!(is_drive_disconnected(&err));
    }

    #[test]
    fn test_is_drive_disconnected_all_matching_kinds() {
        // All these should return true
        assert!(is_drive_disconnected(&std::io::Error::new(
            std::io::ErrorKind::NotFound,
            ""
        )));
        assert!(is_drive_disconnected(&std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            ""
        )));
        assert!(is_drive_disconnected(&std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            ""
        )));
    }

    #[test]
    fn test_is_drive_disconnected_non_matching_kinds() {
        // All these should return false
        assert!(!is_drive_disconnected(&std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            ""
        )));
        assert!(!is_drive_disconnected(&std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            ""
        )));
        assert!(!is_drive_disconnected(&std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            ""
        )));
        assert!(!is_drive_disconnected(&std::io::Error::new(
            std::io::ErrorKind::WriteZero,
            ""
        )));
        assert!(!is_drive_disconnected(&std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            ""
        )));
    }

    #[test]
    fn test_is_drive_disconnected_with_other_os_error_codes() {
        // Test non-matching OS error codes
        let err = std::io::Error::from_raw_os_error(1); // EPERM
        assert!(!is_drive_disconnected(&err));

        let err = std::io::Error::from_raw_os_error(13); // EACCES
        assert!(!is_drive_disconnected(&err));
    }

    #[test]
    fn test_is_drive_disconnected_no_os_error() {
        // Test error without raw OS error code
        let err = std::io::Error::new(std::io::ErrorKind::Other, "generic error");
        assert!(!is_drive_disconnected(&err));
    }

    // Helper struct for testing progress callbacks
    struct TestProgressCallback {
        updates: std::sync::Arc<std::sync::Mutex<Vec<FlashProgress>>>,
    }

    impl TestProgressCallback {
        fn new() -> Self {
            Self {
                updates: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            }
        }
    }

    impl ProgressCallback for TestProgressCallback {
        fn on_progress(&self, progress: FlashProgress) {
            self.updates.lock().unwrap().push(progress);
        }
    }

    // macOS-specific tests
    #[cfg(target_os = "macos")]
    mod macos_tests {
        use super::*;

        #[tokio::test]
        #[serial]
        async fn test_write_image_nonexistent_file() {
            let callback = TestProgressCallback::new();
            let image_path = PathBuf::from("/tmp/nonexistent_image_file.img");
            let device_id = "/dev/disk99";

            let result = write_image(&image_path, device_id, false, &callback).await;
            assert!(result.is_err());
        }

        #[tokio::test]
        #[serial]
        async fn test_write_image_with_invalid_device() {
            let callback = TestProgressCallback::new();
            let temp_file = tempfile::NamedTempFile::new().unwrap();

            // Write some test data
            std::fs::write(temp_file.path(), b"test data").unwrap();
            let image_path = temp_file.path().to_path_buf();

            // Use an invalid device path
            let device_id = "/dev/nonexistent_disk999";

            let result = write_image(&image_path, device_id, false, &callback).await;
            // Should fail when trying to unmount or access the device
            assert!(result.is_err());
        }
    }

    // Linux-specific tests
    #[cfg(target_os = "linux")]
    mod linux_tests {
        use super::*;

        #[tokio::test]
        #[serial]
        async fn test_write_image_nonexistent_file() {
            let callback = TestProgressCallback::new();
            let image_path = PathBuf::from("/tmp/nonexistent_image_file.img");
            let device_id = "/dev/hai-test-nonexistent";

            // The image check runs before device validation and any D-Bus
            // call, so a missing image surfaces as Io even with a bad device.
            let result = write_image(&image_path, device_id, false, &callback).await;
            assert!(matches!(result.unwrap_err(), Error::Io(_)));
        }
    }

    // Windows-specific tests
    #[cfg(target_os = "windows")]
    mod windows_tests {
        use super::*;

        #[tokio::test]
        #[serial]
        async fn test_write_image_nonexistent_file() {
            let callback = TestProgressCallback::new();
            let image_path = PathBuf::from("C:\\nonexistent_image_file.img");
            let device_id = "\\\\.\\PhysicalDrive1";

            let result = write_image(&image_path, device_id, false, &callback).await;
            assert!(result.is_err());
        }

        #[tokio::test]
        #[serial]
        async fn test_write_image_invalid_device() {
            let callback = TestProgressCallback::new();
            let temp_file = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(temp_file.path(), b"test data").unwrap();
            let image_path = temp_file.path().to_path_buf();

            let device_id = "\\\\.\\PhysicalDrive999";

            let result = write_image(&image_path, device_id, false, &callback).await;
            assert!(result.is_err());
        }
    }

    // Test unsupported platforms (these tests will only run on non-standard platforms)
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    mod unsupported_platform_tests {
        use super::*;

        #[tokio::test]
        async fn test_write_image_unsupported_platform() {
            let callback = TestProgressCallback::new();
            let temp_file = tempfile::NamedTempFile::new().unwrap();
            let image_path = temp_file.path().to_path_buf();
            let device_id = "/dev/sdb";

            let result = write_image(&image_path, device_id, false, &callback).await;
            assert!(result.is_err());
            assert!(matches!(result.unwrap_err(), Error::UnsupportedPlatform(_)));
        }
    }

    // Test with Mock mode enabled to exercise more code paths
    #[tokio::test]
    #[serial]
    async fn test_write_image_mock_mode_not_implemented() {
        // Enable mock mode
        std::env::set_var("HA_INSTALLER_MOCK", "1");

        let callback = TestProgressCallback::new();
        let temp_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(temp_file.path(), b"test data").unwrap();
        let image_path = temp_file.path().to_path_buf();

        #[cfg(target_os = "macos")]
        let device_id = "/dev/disk2";
        // Non-resolvable device so write_image fails before any privileged
        // udisks2 call (mock mode isn't honoured by write_image itself).
        #[cfg(target_os = "linux")]
        let device_id = "/dev/hai-test-nonexistent";
        #[cfg(target_os = "windows")]
        let device_id = "\\\\.\\PhysicalDrive1";

        // The write_image function doesn't have mock support yet,
        // so it will try to execute real commands which will fail
        let result = write_image(&image_path, device_id, false, &callback).await;

        // Clean up
        std::env::remove_var("HA_INSTALLER_MOCK");

        // Expected to fail as there's no mock implementation for write_image
        assert!(result.is_err());
    }

    #[tokio::test]
    #[serial]
    async fn test_write_image_with_verification_flag() {
        let callback = TestProgressCallback::new();
        let temp_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(temp_file.path(), b"test data").unwrap();
        let image_path = temp_file.path().to_path_buf();

        #[cfg(target_os = "macos")]
        let device_id = "/dev/disk99";
        #[cfg(target_os = "linux")]
        let device_id = "/dev/hai-test-nonexistent";
        #[cfg(target_os = "windows")]
        let device_id = "\\\\.\\PhysicalDrive99";

        // Test with verify=true flag
        let result = write_image(&image_path, device_id, true, &callback).await;

        // Should fail because device doesn't exist, but this exercises the verify code path
        assert!(result.is_err());
    }

    // Test creating actual temp file and trying to write (will fail safely)
    #[tokio::test]
    #[serial]
    async fn test_write_image_with_real_temp_file() {
        let callback = TestProgressCallback::new();

        // Create a temp file with some content
        let temp_file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(temp_file.path(), b"test image data").unwrap();
        let image_path = temp_file.path().to_path_buf();

        // Try to write to a nonexistent device
        #[cfg(target_os = "macos")]
        let device_id = "/dev/disk999";
        #[cfg(target_os = "linux")]
        let device_id = "/dev/hai-test-nonexistent";
        #[cfg(target_os = "windows")]
        let device_id = "\\\\.\\PhysicalDrive999";

        let result = write_image(&image_path, device_id, false, &callback).await;

        // Should fail because device doesn't exist
        assert!(result.is_err());

        // Progress updates may or may not have been sent depending on when the failure occurred
        // Just verify the function was called and failed appropriately
    }

    // Test all ErrorKind variants for is_drive_disconnected
    #[test]
    fn test_is_drive_disconnected_comprehensive() {
        use std::io::ErrorKind;

        // These should return true
        let disconnect_kinds = [
            ErrorKind::NotFound,
            ErrorKind::BrokenPipe,
            ErrorKind::UnexpectedEof,
        ];
        for kind in &disconnect_kinds {
            assert!(
                is_drive_disconnected(&std::io::Error::new(*kind, "test")),
                "{:?} should be detected as disconnected",
                kind
            );
        }

        // These should return false
        let other_kinds = [
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
        ];
        for kind in &other_kinds {
            assert!(
                !is_drive_disconnected(&std::io::Error::new(*kind, "test")),
                "{:?} should NOT be detected as disconnected",
                kind
            );
        }
    }
}
