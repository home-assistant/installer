//! Block device enumeration for different platforms
//!
//! This module provides platform-specific implementations for listing
//! block devices (SD cards, USB drives, etc.) that can be used as
//! installation targets.

use crate::error::Result;
use crate::types::{BlockDevice, DeviceType};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// List all available block devices on the system
///
/// Returns removable devices suitable for flashing (SD cards, USB drives, etc.)
/// Filters out internal and system drives for safety.
pub async fn list_devices() -> Result<Vec<BlockDevice>> {
    #[cfg(feature = "mock")]
    {
        if crate::is_mock_enabled() {
            return Ok(crate::mock::get_mock_block_devices());
        }
    }

    #[cfg(target_os = "macos")]
    {
        macos::list_devices().await
    }

    #[cfg(target_os = "linux")]
    {
        linux::list_devices().await
    }

    #[cfg(target_os = "windows")]
    {
        windows::list_devices().await
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err(crate::error::Error::UnsupportedPlatform(
            "Block device enumeration".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn test_device_type_values() {
        // Ensure all device types can be created
        let types = vec![
            DeviceType::SdCard,
            DeviceType::UsbDrive,
            DeviceType::Ssd,
            DeviceType::Hdd,
            DeviceType::NvMe,
            DeviceType::Unknown,
        ];

        for device_type in types {
            let json = serde_json::to_string(&device_type).unwrap();
            assert!(!json.is_empty());
        }
    }

    #[test]
    fn test_block_device_creation() {
        let device = BlockDevice {
            id: "/dev/sdb".to_string(),
            name: "Test Device".to_string(),
            size: 32_000_000_000,
            device_type: DeviceType::UsbDrive,
            removable: true,
            model: Some("Test Model".to_string()),
            vendor: Some("Test Vendor".to_string()),
        };

        assert_eq!(device.id, "/dev/sdb");
        assert_eq!(device.size, 32_000_000_000);
        assert!(device.removable);
    }

    #[cfg(feature = "mock")]
    #[tokio::test]
    #[serial]
    async fn test_list_devices_returns_mock_data() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let devices = list_devices().await.unwrap();
        assert!(!devices.is_empty());
        // Verify we get the expected mock devices
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[cfg(feature = "mock")]
    #[tokio::test]
    #[serial]
    async fn test_list_devices_mock_devices_have_valid_structure() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let devices = list_devices().await.unwrap();
        for device in &devices {
            assert!(!device.id.is_empty());
            assert!(!device.name.is_empty());
            assert!(device.size > 0);
        }
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[cfg(feature = "mock")]
    #[tokio::test]
    #[serial]
    async fn test_list_devices_mock_has_various_device_types() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let devices = list_devices().await.unwrap();
        // Check that we have different device types
        let has_sd = devices
            .iter()
            .any(|d| matches!(d.device_type, DeviceType::SdCard));
        let has_usb = devices
            .iter()
            .any(|d| matches!(d.device_type, DeviceType::UsbDrive));
        assert!(has_sd || has_usb, "Mock should have SD or USB devices");
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[cfg(feature = "mock")]
    #[tokio::test]
    #[serial]
    async fn test_list_devices_without_mock_env() {
        std::env::remove_var("HA_INSTALLER_MOCK");
        let devices = list_devices().await;
        // Should use the real platform implementation, not mock
        assert!(devices.is_ok());
        std::env::remove_var("HA_INSTALLER_MOCK");
    }
}
