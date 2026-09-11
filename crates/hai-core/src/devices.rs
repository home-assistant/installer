//! Block device enumeration for different platforms
//!
//! This module provides platform-specific implementations for listing
//! block devices (SD cards, USB drives, etc.) that can be used as
//! installation targets.

use crate::error::Result;
use crate::types::{BlockDevice, DeviceType};

#[cfg(target_os = "linux")]
#[path = "devices/linux.rs"]
mod imp;
#[cfg(target_os = "macos")]
#[path = "devices/macos.rs"]
mod imp;
#[cfg(target_os = "windows")]
#[path = "devices/windows.rs"]
mod imp;

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
compile_error!("hai-core supports only Linux, macOS and Windows");

/// List all available block devices on the system
///
/// Returns removable devices suitable for flashing (SD cards, USB drives, etc.)
/// Filters out internal and system drives for safety.
pub async fn list_devices() -> Result<Vec<BlockDevice>> {
    imp::list_devices().await
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[tokio::test]
    async fn test_list_devices_succeeds() {
        // Smoke test: the real platform enumeration runs and succeeds.
        assert!(list_devices().await.is_ok());
    }
}
