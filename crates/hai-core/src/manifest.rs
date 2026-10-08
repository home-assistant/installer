//! Device manifest bundled with the installer
//!
//! Lists the supported boards and where to download their HAOS images.
//!
//! Capacity policy: minimum 16 GB / recommended 32 GB nominal drive capacity.
//! HA recommends 32 GB (https://www.home-assistant.io/faq/); the ODROID guide
//! still lists 16 GB eMMC configurations (https://www.home-assistant.io/installation/odroid/).
//! Keep both values per board so requirements can evolve independently.
//! Reported capacity may be up to 5% lower than nominal (15.2 / 30.4 GB),
//! allowing manufacturer-reserved space on cards and eMMC. The exact extracted
//! image size must still fit the actual drive before writing.

use crate::types::{Device, DeviceCategory, DeviceManifest, HaosConfig};

/// Returns the device manifest bundled with the installer
pub fn bundled_manifest() -> DeviceManifest {
    DeviceManifest {
        version: 1,
        devices: vec![
            // Raspberry Pi devices
            Device {
                id: "rpi5".to_string(),
                name: "Raspberry Pi 5".to_string(),
                category: DeviceCategory::RaspberryPi,
                image_url: Some("/assets/devices/raspberry_pi_5.png".to_string()),
                haos: HaosConfig {
                    minimum_storage_bytes: 16_000_000_000,
                    recommended_storage_bytes: 32_000_000_000,
                    board: "rpi5-64".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_rpi5-64-{version}.img.xz".to_string(),
                },
            },
            Device {
                id: "rpi4".to_string(),
                name: "Raspberry Pi 4".to_string(),
                category: DeviceCategory::RaspberryPi,
                image_url: Some("/assets/devices/raspberry_pi_4.png".to_string()),
                haos: HaosConfig {
                    minimum_storage_bytes: 16_000_000_000,
                    recommended_storage_bytes: 32_000_000_000,
                    board: "rpi4-64".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_rpi4-64-{version}.img.xz".to_string(),
                },
            },
            Device {
                id: "rpi3".to_string(),
                name: "Raspberry Pi 3".to_string(),
                category: DeviceCategory::RaspberryPi,
                image_url: Some("/assets/devices/raspberry_pi_3.png".to_string()),
                haos: HaosConfig {
                    minimum_storage_bytes: 16_000_000_000,
                    recommended_storage_bytes: 32_000_000_000,
                    board: "rpi3-64".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_rpi3-64-{version}.img.xz".to_string(),
                },
            },
            // ODROID devices
            Device {
                id: "odroid-n2".to_string(),
                name: "ODROID-N2/N2+".to_string(),
                category: DeviceCategory::Odroid,
                image_url: Some("/assets/devices/hardkernel_odroid-n2.png".to_string()),
                haos: HaosConfig {
                    minimum_storage_bytes: 16_000_000_000,
                    recommended_storage_bytes: 32_000_000_000,
                    board: "odroid-n2".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_odroid-n2-{version}.img.xz".to_string(),
                },
            },
            Device {
                id: "odroid-c2".to_string(),
                name: "ODROID-C2".to_string(),
                category: DeviceCategory::Odroid,
                image_url: Some("/assets/devices/hardkernel_odroid-c2.png".to_string()),
                haos: HaosConfig {
                    minimum_storage_bytes: 16_000_000_000,
                    recommended_storage_bytes: 32_000_000_000,
                    board: "odroid-c2".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_odroid-c2-{version}.img.xz".to_string(),
                },
            },
            Device {
                id: "odroid-c4".to_string(),
                name: "ODROID-C4".to_string(),
                category: DeviceCategory::Odroid,
                image_url: Some("/assets/devices/hardkernel_odroid-c4.png".to_string()),
                haos: HaosConfig {
                    minimum_storage_bytes: 16_000_000_000,
                    recommended_storage_bytes: 32_000_000_000,
                    board: "odroid-c4".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_odroid-c4-{version}.img.xz".to_string(),
                },
            },
            Device {
                id: "odroid-m1".to_string(),
                name: "ODROID-M1".to_string(),
                category: DeviceCategory::Odroid,
                image_url: Some("/assets/devices/hardkernel_odroid-m1.png".to_string()),
                haos: HaosConfig {
                    minimum_storage_bytes: 16_000_000_000,
                    recommended_storage_bytes: 32_000_000_000,
                    board: "odroid-m1".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_odroid-m1-{version}.img.xz".to_string(),
                },
            },
            Device {
                id: "odroid-m1s".to_string(),
                name: "ODROID-M1S".to_string(),
                category: DeviceCategory::Odroid,
                image_url: Some("/assets/devices/hardkernel_odroid-m1s.png".to_string()),
                haos: HaosConfig {
                    minimum_storage_bytes: 16_000_000_000,
                    recommended_storage_bytes: 32_000_000_000,
                    board: "odroid-m1s".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_odroid-m1s-{version}.img.xz".to_string(),
                },
            },
            // Khadas devices
            Device {
                id: "khadas-vim3".to_string(),
                name: "Khadas VIM3".to_string(),
                category: DeviceCategory::Khadas,
                image_url: Some("/assets/devices/khadas_vim3.png".to_string()),
                haos: HaosConfig {
                    minimum_storage_bytes: 16_000_000_000,
                    recommended_storage_bytes: 32_000_000_000,
                    board: "khadas-vim3".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_khadas-vim3-{version}.img.xz".to_string(),
                },
            },
            // Home Assistant Hardware
            Device {
                id: "ha-green".to_string(),
                name: "Home Assistant Green".to_string(),
                category: DeviceCategory::HomeAssistantHardware,
                image_url: Some("/assets/devices/homeassistant_green.png".to_string()),
                haos: HaosConfig {
                    minimum_storage_bytes: 16_000_000_000,
                    recommended_storage_bytes: 32_000_000_000,
                    board: "green".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_green-{version}.img.xz".to_string(),
                },
            },
            Device {
                id: "ha-yellow".to_string(),
                name: "Home Assistant Yellow".to_string(),
                category: DeviceCategory::HomeAssistantHardware,
                image_url: Some("/assets/devices/homeassistant_yellow.png".to_string()),
                haos: HaosConfig {
                    minimum_storage_bytes: 16_000_000_000,
                    recommended_storage_bytes: 32_000_000_000,
                    board: "yellow".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_yellow-{version}.img.xz".to_string(),
                },
            },
            // Generic x86-64
            Device {
                id: "generic-x86-64".to_string(),
                name: "Intel/AMD (x86-64)".to_string(),
                category: DeviceCategory::GenericX86,
                image_url: Some("/assets/icons/cpu-64-bit.svg".to_string()),
                haos: HaosConfig {
                    minimum_storage_bytes: 16_000_000_000,
                    recommended_storage_bytes: 32_000_000_000,
                    board: "generic-x86-64".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_generic-x86-64-{version}.img.xz".to_string(),
                },
            },
            // Generic ARM64
            Device {
                id: "generic-aarch64".to_string(),
                name: "ARM (aarch64)".to_string(),
                category: DeviceCategory::GenericArm64,
                image_url: Some("/assets/icons/chip.svg".to_string()),
                haos: HaosConfig {
                    minimum_storage_bytes: 16_000_000_000,
                    recommended_storage_bytes: 32_000_000_000,
                    board: "generic-aarch64".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_generic-aarch64-{version}.img.xz".to_string(),
                },
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bundled_manifest_has_devices() {
        let manifest = bundled_manifest();
        assert!(!manifest.devices.is_empty());
    }

    #[test]
    fn test_storage_requirements_are_serialized_per_board() {
        let manifest = bundled_manifest();
        let json = serde_json::to_value(&manifest).unwrap();
        for (device, serialized) in manifest
            .devices
            .iter()
            .zip(json["devices"].as_array().unwrap())
        {
            assert!(device.haos.minimum_storage_bytes > 8_000_000_000);
            assert!(device.haos.recommended_storage_bytes >= device.haos.minimum_storage_bytes);
            assert_eq!(
                serialized["haos"]["minimum_storage_bytes"],
                device.haos.minimum_storage_bytes
            );
            assert_eq!(
                serialized["haos"]["recommended_storage_bytes"],
                device.haos.recommended_storage_bytes
            );
        }
    }

    #[test]
    fn test_bundled_manifest_has_unique_device_ids() {
        let manifest = bundled_manifest();
        let mut ids = std::collections::HashSet::new();
        for device in &manifest.devices {
            assert!(
                ids.insert(device.id.clone()),
                "Duplicate device ID found: {}",
                device.id
            );
        }
    }
    #[test]
    fn test_bundled_manifest_version() {
        let manifest = bundled_manifest();
        assert_eq!(manifest.version, 1);
    }
    #[test]
    fn test_bundled_manifest_has_all_categories() {
        let manifest = bundled_manifest();
        let categories: std::collections::HashSet<_> =
            manifest.devices.iter().map(|d| &d.category).collect();

        assert!(
            categories.contains(&DeviceCategory::RaspberryPi),
            "Should have Raspberry Pi devices"
        );
        assert!(
            categories.contains(&DeviceCategory::Odroid),
            "Should have ODROID devices"
        );
        assert!(
            categories.contains(&DeviceCategory::HomeAssistantHardware),
            "Should have Home Assistant hardware"
        );
        assert!(
            categories.contains(&DeviceCategory::GenericX86),
            "Should have generic x86"
        );
        assert!(
            categories.contains(&DeviceCategory::GenericArm64),
            "Should have generic ARM64"
        );
    }
    #[test]
    fn test_bundled_manifest_devices_have_haos_config() {
        let manifest = bundled_manifest();
        for device in &manifest.devices {
            assert!(
                !device.haos.board.is_empty(),
                "Device {} should have HAOS board",
                device.id
            );
            assert!(
                !device.haos.download_url.is_empty(),
                "Device {} should have HAOS download URL",
                device.id
            );
            assert!(
                device.haos.download_url.contains("{version}"),
                "Device {} download URL should have version placeholder",
                device.id
            );
        }
    }
    #[test]
    fn test_bundled_manifest_only_offers_boards_haos_ships() {
        // The boards stable.json lists for flashing, as of HAOS 18.3. A board missing here
        // fails only after the user confirmed the erase, so keep this list
        // in step with HAOS (#157 tracks checking it automatically).
        const SHIPPED: &[&str] = &[
            "generic-aarch64",
            "generic-x86-64",
            "green",
            "khadas-vim3",
            "odroid-c2",
            "odroid-c4",
            "odroid-m1",
            "odroid-m1s",
            "odroid-n2",
            "rpi3-64",
            "rpi4-64",
            "rpi5-64",
            "yellow",
        ];

        for device in bundled_manifest().devices {
            assert!(
                SHIPPED.contains(&device.haos.board.as_str()),
                "Device {} uses board {}, which HAOS doesn't ship",
                device.id,
                device.haos.board
            );
        }
    }

    #[test]
    fn test_bundled_manifest_devices_have_image_urls() {
        let manifest = bundled_manifest();
        for device in &manifest.devices {
            assert!(
                device.image_url.is_some(),
                "Device {} should have image URL",
                device.id
            );
        }
    }
}
