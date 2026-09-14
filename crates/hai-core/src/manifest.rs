//! The built-in catalogue of supported devices.
//!
//! This is real, shipped data: the boards the installer offers and the HAOS
//! image each one downloads. It lives outside `mock` so that release builds,
//! which are compiled without the `mock` feature, still have a device list.

use crate::types::{Device, DeviceCategory, DeviceManifest, HaosConfig};

/// Returns the device manifest built into the binary.
pub fn builtin_manifest() -> DeviceManifest {
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
                    board: "odroid-m1s".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_odroid-m1s-{version}.img.xz".to_string(),
                },
            },
            Device {
                id: "odroid-xu4".to_string(),
                name: "ODROID-XU4".to_string(),
                category: DeviceCategory::Odroid,
                image_url: Some("/assets/devices/hardkernel_odroid-xu4.png".to_string()),
                haos: HaosConfig {
                    board: "odroid-xu".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_odroid-xu-{version}.img.xz".to_string(),
                },
            },
            // Khadas devices
            Device {
                id: "khadas-vim3".to_string(),
                name: "Khadas VIM3".to_string(),
                category: DeviceCategory::Khadas,
                image_url: Some("/assets/devices/khadas_vim3.png".to_string()),
                haos: HaosConfig {
                    board: "khadas-vim3".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_khadas-vim3-{version}.img.xz".to_string(),
                },
            },
            // ASUS devices
            Device {
                id: "asus-tinker".to_string(),
                name: "ASUS Tinker Board".to_string(),
                category: DeviceCategory::Asus,
                image_url: Some("/assets/devices/asus_tinker.png".to_string()),
                haos: HaosConfig {
                    board: "tinker".to_string(),
                    download_url: "https://github.com/home-assistant/operating-system/releases/download/{version}/haos_tinker-{version}.img.xz".to_string(),
                },
            },
            // Home Assistant Hardware
            Device {
                id: "ha-green".to_string(),
                name: "Home Assistant Green".to_string(),
                category: DeviceCategory::HomeAssistantHardware,
                image_url: Some("/assets/devices/homeassistant_green.png".to_string()),
                haos: HaosConfig {
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
    fn test_builtin_manifest_has_devices() {
        let manifest = builtin_manifest();
        assert!(!manifest.devices.is_empty());
    }

    #[test]
    fn test_builtin_manifest_has_unique_device_ids() {
        let manifest = builtin_manifest();
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
    fn test_builtin_manifest_version() {
        let manifest = builtin_manifest();
        assert_eq!(manifest.version, 1);
    }

    #[test]
    fn test_builtin_manifest_has_all_categories() {
        let manifest = builtin_manifest();
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
    fn test_builtin_manifest_devices_have_haos_config() {
        let manifest = builtin_manifest();
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
    fn test_builtin_manifest_devices_have_image_urls() {
        let manifest = builtin_manifest();
        for device in &manifest.devices {
            assert!(
                device.image_url.is_some(),
                "Device {} should have image URL",
                device.id
            );
        }
    }
}
