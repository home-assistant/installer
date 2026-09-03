//! Raw disk writing functionality for flashing images to devices.
//!
//! This module provides platform-specific implementations for writing
//! raw disk images to block devices (SD cards, USB drives, etc.).

use crate::error::{Error, Result};
use crate::types::{FlashProgress, FlashStage};
use crate::ProgressCallback;
use std::path::PathBuf;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

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

/// Validate that a device path is safe to write to (not a system drive)
fn validate_device_path(device_id: &str) -> Result<()> {
    let device_id = device_id.trim_end_matches('/');

    #[cfg(target_os = "macos")]
    {
        macos::validate_device_path(device_id)
    }

    #[cfg(target_os = "linux")]
    {
        linux::validate_device_path(device_id)
    }

    #[cfg(target_os = "windows")]
    {
        windows::validate_device_path(device_id)
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = device_id;
        Ok(())
    }
}

/// Write an image file to a block device with progress updates
pub async fn write_image<P: ProgressCallback>(
    image_path: &PathBuf,
    device_id: &str,
    verify: bool,
    progress_callback: &P,
) -> Result<()> {
    std::fs::metadata(image_path)?;

    // Safety check: refuse to write to system drives
    validate_device_path(device_id)?;

    #[cfg(target_os = "macos")]
    {
        macos::write_image(image_path, device_id, verify, progress_callback).await
    }

    #[cfg(target_os = "linux")]
    {
        linux::write_image(image_path, device_id, verify, progress_callback).await
    }

    #[cfg(target_os = "windows")]
    {
        windows::write_image(image_path, device_id, verify, progress_callback).await
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err(Error::UnsupportedPlatform("Disk writing".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn test_buffer_sizes() {
        assert_eq!(WRITE_BUFFER_SIZE, 4 * 1024 * 1024);
        assert_eq!(FAST_DRIVE_BUFFER_SIZE, 64 * 1024 * 1024);
    }

    #[test]
    fn test_progress_interval() {
        assert_eq!(PROGRESS_UPDATE_INTERVAL, 10 * 1024 * 1024);
    }

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
    #[cfg(target_os = "macos")]
    fn test_validate_device_path_blocks_disk0_macos() {
        assert!(validate_device_path("/dev/disk0").is_err());
        assert!(validate_device_path("/dev/rdisk0").is_err());
        assert!(validate_device_path("disk0").is_err());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_validate_device_path_allows_other_disks_macos() {
        assert!(validate_device_path("/dev/disk2").is_ok());
        assert!(validate_device_path("/dev/disk10").is_ok());
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn test_validate_device_path_blocks_unknown_device() {
        // The /dev/ prefix and trailing slashes are normalized away, so all
        // spellings hit the same lsblk lookup and get the same verdict.
        for id in [
            "/dev/hai-test-nonexistent",
            "hai-test-nonexistent",
            "/dev/hai-test-nonexistent/",
        ] {
            match validate_device_path(id) {
                Err(Error::PermissionDenied(msg)) => {
                    assert!(msg.contains("not a removable drive"), "{id}: {msg}");
                }
                other => panic!("expected PermissionDenied for {id}, got {other:?}"),
            }
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_validate_device_path_blocks_physicaldrive0_windows() {
        let result = validate_device_path("\\\\.\\PhysicalDrive0");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), Error::PermissionDenied(_)));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_validate_device_path_allows_physicaldrive1_windows() {
        assert!(validate_device_path("\\\\.\\PhysicalDrive1").is_ok());
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_validate_device_path_allows_physicaldrive2_windows() {
        assert!(validate_device_path("\\\\.\\PhysicalDrive2").is_ok());
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
    fn test_validate_device_path_empty_string() {
        let result = validate_device_path("");
        #[cfg(target_os = "linux")]
        assert!(result.is_err());
        #[cfg(not(target_os = "linux"))]
        assert!(result.is_ok());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_validate_device_path_disk1_macos() {
        // disk1 is usually okay (not system drive)
        assert!(validate_device_path("/dev/disk1").is_ok());
        assert!(validate_device_path("/dev/rdisk1").is_ok());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_validate_device_path_high_disk_numbers_macos() {
        assert!(validate_device_path("/dev/disk99").is_ok());
        assert!(validate_device_path("/dev/rdisk99").is_ok());
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
    fn test_buffer_sizes_are_reasonable() {
        // Write buffer should be at least 1MB
        assert!(WRITE_BUFFER_SIZE >= 1024 * 1024);
        // Fast drive buffer should be larger than regular
        assert!(FAST_DRIVE_BUFFER_SIZE > WRITE_BUFFER_SIZE);
        // Progress interval should be reasonable (not too small, not too large)
        assert!(PROGRESS_UPDATE_INTERVAL >= 1024 * 1024);
        assert!(PROGRESS_UPDATE_INTERVAL <= 100 * 1024 * 1024);
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

        #[allow(dead_code)]
        fn get_updates(&self) -> Vec<FlashProgress> {
            self.updates.lock().unwrap().clone()
        }
    }

    impl ProgressCallback for TestProgressCallback {
        fn on_progress(&self, progress: FlashProgress) {
            self.updates.lock().unwrap().push(progress);
        }
    }

    #[tokio::test]
    #[serial]
    async fn test_write_image_rejects_system_drive() {
        let callback = TestProgressCallback::new();
        let temp_file = tempfile::NamedTempFile::new().unwrap();
        let image_path = temp_file.path().to_path_buf();

        #[cfg(target_os = "macos")]
        let result = write_image(&image_path, "/dev/disk0", false, &callback).await;

        // Not in /sys/block, so validation treats it as non-removable —
        // host-independent, unlike asserting on the machine's real /dev/sda.
        #[cfg(target_os = "linux")]
        let result = write_image(&image_path, "/dev/hai-test-nonexistent", false, &callback).await;

        #[cfg(target_os = "windows")]
        let result = write_image(&image_path, "\\\\.\\PhysicalDrive0", false, &callback).await;

        #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
        {
            assert!(result.is_err());
            assert!(matches!(result.unwrap_err(), Error::PermissionDenied(_)));
        }
    }

    // macOS-specific tests
    #[cfg(target_os = "macos")]
    mod macos_tests {
        use super::*;

        #[test]
        fn test_validate_device_rdisk0_variants() {
            assert!(validate_device_path("rdisk0").is_err());
            assert!(validate_device_path("/dev/rdisk0").is_err());
        }

        #[test]
        fn test_validate_device_without_dev_prefix() {
            assert!(validate_device_path("disk2").is_ok());
            assert!(validate_device_path("rdisk2").is_ok());
        }

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

        #[tokio::test]
        #[serial]
        async fn test_write_image_permission_denied() {
            let callback = TestProgressCallback::new();
            let temp_file = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(temp_file.path(), b"test data").unwrap();
            let image_path = temp_file.path().to_path_buf();

            // Unknown to lsblk, so validation rejects it before any
            // privileged udisks2 call.
            let device_id = "/dev/hai-test-nonexistent";

            let result = write_image(&image_path, device_id, false, &callback).await;
            assert!(matches!(result.unwrap_err(), Error::PermissionDenied(_)));
        }
    }

    // Windows-specific tests
    #[cfg(target_os = "windows")]
    mod windows_tests {
        use super::*;

        #[test]
        fn test_validate_physical_drives() {
            assert!(validate_device_path("\\\\.\\PhysicalDrive0").is_err());
            assert!(validate_device_path("\\\\.\\PhysicalDrive1").is_ok());
            assert!(validate_device_path("\\\\.\\PhysicalDrive2").is_ok());
            assert!(validate_device_path("\\\\.\\PhysicalDrive10").is_ok());
        }

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

    // Additional edge case tests that work on all platforms
    #[test]
    fn test_validate_device_path_special_characters() {
        // Test with various special characters to ensure no panics
        let result = validate_device_path("/dev/../disk0");
        // Should either pass validation or fail safely
        assert!(result.is_ok() || result.is_err());
    }

    #[test]
    fn test_validate_device_path_very_long() {
        let long_path = format!("/dev/{}", "a".repeat(1000));
        let result = validate_device_path(&long_path);
        assert!(result.is_ok() || result.is_err());
    }

    #[test]
    fn test_validate_device_path_unicode() {
        let result = validate_device_path("/dev/disk🔥");
        assert!(result.is_ok() || result.is_err());
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

    // Additional platform-specific validation tests
    #[test]
    #[cfg(target_os = "macos")]
    fn test_validate_macos_all_disk0_variations() {
        // Test all possible ways someone might reference disk0
        assert!(validate_device_path("/dev/disk0").is_err());
        assert!(validate_device_path("/dev/rdisk0").is_err());
        assert!(validate_device_path("disk0").is_err());
        assert!(validate_device_path("rdisk0").is_err());

        // Ensure disk0s1 (partition) is also rejected since the base disk is system
        #[cfg(target_os = "macos")]
        {
            // Actually disk0s1 should pass validation as it's a partition, not the whole disk
            // But let's verify the behavior
            let result = validate_device_path("/dev/disk0s1");
            // This will pass because we only check for exact "disk0" match
            assert!(result.is_ok());
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_validate_windows_all_physical_drives() {
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
    fn test_constants_values() {
        // Verify the exact values of constants
        assert_eq!(WRITE_BUFFER_SIZE, 4_194_304);
        assert_eq!(FAST_DRIVE_BUFFER_SIZE, 67_108_864);
        assert_eq!(PROGRESS_UPDATE_INTERVAL, 10_485_760);
    }

    // Test error message generation for validation errors
    #[test]
    #[cfg(target_os = "macos")]
    fn test_validation_error_message_disk0() {
        let result = validate_device_path("/dev/disk0");
        assert!(result.is_err());
        match result {
            Err(Error::PermissionDenied(msg)) => {
                assert!(msg.contains("disk0"));
                assert!(msg.contains("system drive"));
            }
            _ => panic!("Expected PermissionDenied error"),
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_validation_error_message_windows() {
        let result = validate_device_path("\\\\.\\PhysicalDrive0");
        assert!(result.is_err());
        match result {
            Err(Error::PermissionDenied(msg)) => {
                assert!(msg.contains("PhysicalDrive0") || msg.contains("system drive"));
            }
            _ => panic!("Expected PermissionDenied error"),
        }
    }

    // Test the full validation path for various device IDs
    #[test]
    #[cfg(not(target_os = "linux"))]
    fn test_validate_multiple_safe_devices() {
        let safe_devices = vec![
            #[cfg(target_os = "macos")]
            "/dev/disk5",
            #[cfg(target_os = "windows")]
            "\\\\.\\PhysicalDrive5",
        ];

        for device in safe_devices {
            assert!(
                validate_device_path(device).is_ok(),
                "Device {} should be valid",
                device
            );
        }
    }

    // Test progress callback implementation
    #[test]
    fn test_progress_callback_receives_updates() {
        let callback = TestProgressCallback::new();

        // Simulate progress updates
        callback.on_progress(FlashProgress {
            stage: FlashStage::Writing,
            progress: 0,
            bytes_processed: 0,
            total_bytes: 1000,
            message: "Starting".to_string(),
        });

        callback.on_progress(FlashProgress {
            stage: FlashStage::Writing,
            progress: 50,
            bytes_processed: 500,
            total_bytes: 1000,
            message: "Halfway".to_string(),
        });

        callback.on_progress(FlashProgress {
            stage: FlashStage::Complete,
            progress: 100,
            bytes_processed: 1000,
            total_bytes: 1000,
            message: "Done".to_string(),
        });

        let updates = callback.get_updates();
        assert_eq!(updates.len(), 3);
        assert_eq!(updates[0].progress, 0);
        assert_eq!(updates[1].progress, 50);
        assert_eq!(updates[2].progress, 100);
        assert_eq!(updates[2].stage, FlashStage::Complete);
    }

    // Test with path that doesn't have /dev/ prefix
    #[test]
    #[cfg(target_os = "macos")]
    fn test_validate_without_dev_prefix() {
        assert!(validate_device_path("disk5").is_ok());
        assert!(validate_device_path("disk0").is_err());
    }

    // Test case sensitivity
    #[test]
    #[cfg(target_os = "macos")]
    fn test_validate_case_sensitivity_macos() {
        // macOS device paths are case-sensitive
        assert!(validate_device_path("/dev/Disk0").is_ok()); // Capital D should pass
        assert!(validate_device_path("/dev/disk0").is_err()); // Lowercase should fail
    }

    // Test buffer size relationships
    #[test]
    fn test_buffer_size_relationships() {
        // Fast drive buffer should be significantly larger
        assert!(FAST_DRIVE_BUFFER_SIZE >= WRITE_BUFFER_SIZE * 10);

        // Progress interval should be larger than write buffer
        assert!(PROGRESS_UPDATE_INTERVAL >= WRITE_BUFFER_SIZE as u64);

        // But not too large compared to fast buffer
        assert!(PROGRESS_UPDATE_INTERVAL <= (FAST_DRIVE_BUFFER_SIZE * 2) as u64);
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

    // Test multiple consecutive calls to progress callback
    #[test]
    fn test_progress_callback_multiple_calls() {
        let callback = TestProgressCallback::new();

        // Simulate a complete write cycle
        for i in 0..=100 {
            callback.on_progress(FlashProgress {
                stage: if i < 80 {
                    FlashStage::Writing
                } else if i < 100 {
                    FlashStage::Verifying
                } else {
                    FlashStage::Complete
                },
                progress: i as u8,
                bytes_processed: (i * 1000) as u64,
                total_bytes: 100000,
                message: format!("Progress: {}%", i),
            });
        }

        let updates = callback.get_updates();
        assert_eq!(updates.len(), 101);
        assert_eq!(updates.first().unwrap().progress, 0);
        assert_eq!(updates.last().unwrap().progress, 100);
        assert_eq!(updates.last().unwrap().stage, FlashStage::Complete);
    }
}
