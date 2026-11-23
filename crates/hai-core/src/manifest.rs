//! Device manifest bundled with the installer
//!
//! Lists the supported boards.
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
                },
            },
        ],
    }
}

/// Storage requirements for `board`: a board from the manifest, or the board
/// of a pinned Home Assistant hardware installer.
pub fn storage_requirements(board: &str) -> Option<HaosConfig> {
    bundled_manifest()
        .devices
        .into_iter()
        .find(|device| device.haos.board == board)
        .map(|device| device.haos)
        .or_else(|| crate::hardware_installer::find(board).map(|installer| installer.storage()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ImageFormat;

    #[test]
    fn storage_requirements_cover_manifest_and_installer_boards() {
        let blue = storage_requirements("odroid-n2").unwrap();
        assert_eq!(blue.minimum_storage_bytes, 16_000_000_000);
        for board in ["green-installer", "yellow-installer"] {
            let installer = storage_requirements(board).unwrap();
            assert_eq!(installer.board, board);
            assert_eq!(installer.minimum_storage_bytes, 1_000_000_000);
        }
        assert!(storage_requirements("unknown-board").is_none());
    }

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
        }
    }
    /// The stable.json version of each bundled board.
    fn bundled_board_versions(
        stable: &crate::types::StableVersionInfo,
    ) -> Result<std::collections::BTreeMap<String, String>, String> {
        bundled_manifest()
            .devices
            .into_iter()
            .map(|device| {
                let board = device.haos.board;
                let version =
                    stable.hassos.get(&board).cloned().ok_or_else(|| {
                        format!("Bundled board {board} is missing from stable.json")
                    })?;
                Ok((board, version))
            })
            .collect()
    }

    #[test]
    fn catalog_check_needs_every_bundled_board_in_stable_json() {
        let mut stable = crate::types::StableVersionInfo {
            hassos: bundled_manifest()
                .devices
                .into_iter()
                .map(|device| (device.haos.board, "18.3".into()))
                .collect(),
        };
        stable.hassos.insert("odroid-n2".into(), "18.2".into());
        let versions = bundled_board_versions(&stable).unwrap();
        assert_eq!(versions["odroid-n2"], "18.2");
        assert_eq!(versions["rpi5-64"], "18.3");
        stable.hassos.remove("odroid-n2");
        assert!(bundled_board_versions(&stable)
            .unwrap_err()
            .contains("odroid-n2 is missing"));
    }

    #[tokio::test]
    #[ignore = "live GitHub metadata and signature check; run explicitly in CI"]
    async fn bundled_boards_have_stable_release_assets() {
        // Fails for a while after stable.json moves a board to a new HAOS
        // version, until the full images built from it are out.
        let stable = crate::download::get_stable_version()
            .await
            .expect("Could not fetch stable HAOS board versions");
        let mut needed: Vec<(String, String, ImageFormat)> = bundled_board_versions(&stable)
            .expect("Bundled board has no stable release")
            .into_iter()
            .map(|(board, version)| (board, version, ImageFormat::Raw))
            .collect();
        // The VMs: Proxmox imports the ova board's qcow2, UTM generic-aarch64's
        for board in [crate::proxmox::HAOS_BOARD, crate::utm::HAOS_BOARD] {
            let version = stable
                .hassos
                .get(board)
                .unwrap_or_else(|| panic!("VM board {board} is missing from stable.json"))
                .clone();
            needed.push((board.to_string(), version, ImageFormat::Qcow2));
        }
        let mut unusable = Vec::new();
        for (board, version, format) in needed {
            match crate::download::full_images::release_for_board(&board, &version).await {
                Ok(release) if release.require_image(&board, format).is_ok() => {}
                Ok(_) => unusable.push(format!("{board} {version}: no {format:?} image")),
                Err(error) => unusable.push(format!("{board} {version}: {error}")),
            }
        }
        assert!(
            unusable.is_empty(),
            "Bundled boards without a verified full image of their stable HAOS: {}",
            unusable.join("; ")
        );
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
