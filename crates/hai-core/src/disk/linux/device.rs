//! Linux block device enumeration via `lsblk`.

use super::super::*;
use crate::error::Error;
use serde::Deserialize;
use std::process::Command;

#[derive(Debug, Deserialize)]
struct LsblkOutput {
    blockdevices: Vec<LsblkDevice>,
}

#[derive(Debug, Deserialize)]
pub(super) struct LsblkDevice {
    pub(super) name: String,
    #[serde(default)]
    pub(super) size: Option<u64>,
    #[serde(rename = "type", default)]
    pub(super) device_type: Option<String>,
    #[serde(default)]
    pub(super) rm: Option<bool>, // removable
    #[serde(default)]
    pub(super) ro: Option<bool>, // read-only
    #[serde(default)]
    pub(super) tran: Option<String>, // transport (usb, sata, nvme, etc.)
    #[serde(default)]
    pub(super) model: Option<String>,
    #[serde(default)]
    pub(super) vendor: Option<String>,
    #[serde(default)]
    pub(super) hotplug: Option<bool>,
}

pub async fn list_devices() -> Result<Vec<BlockDevice>> {
    // Use lsblk with JSON output for reliable parsing
    let output = Command::new("lsblk")
        .args([
            "-J", // JSON output
            "-b", // Size in bytes
            "-d", // Don't show partitions
            "-o", // Output columns
            "NAME,SIZE,TYPE,RM,RO,TRAN,MODEL,VENDOR,HOTPLUG",
        ])
        .output()
        .map_err(Error::Io)?;

    if !output.status.success() {
        return Err(Error::DeviceNotFound(format!(
            "lsblk failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    let lsblk: LsblkOutput = serde_json::from_slice(&output.stdout)?;

    let mut devices = Vec::new();

    for dev in lsblk.blockdevices {
        // Only include disk devices (not partitions, loop devices, etc.)
        if dev.device_type.as_deref() != Some("disk") {
            continue;
        }

        // Skip read-only devices
        if dev.ro == Some(true) {
            continue;
        }

        // Skip non-removable, non-hotplug devices (likely system drives)
        let is_removable = dev.rm == Some(true) || dev.hotplug == Some(true);
        if !is_removable {
            continue;
        }

        // Skip very small devices (< 1GB)
        let size = dev.size.unwrap_or(0);
        if size < 1_000_000_000 {
            continue;
        }

        // Determine device type
        let device_type = determine_device_type(&dev);

        // Clean up model and vendor strings
        let model = dev
            .model
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let vendor = dev
            .vendor
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        // Build human-readable name
        let name = build_device_name(&dev.name, &vendor, &model);

        devices.push(BlockDevice {
            id: format!("/dev/{}", dev.name),
            name,
            size,
            device_type,
            removable: is_removable,
            model,
            vendor,
        });
    }

    Ok(devices)
}

pub(super) fn determine_device_type(dev: &LsblkDevice) -> DeviceType {
    let transport = dev.tran.as_deref().unwrap_or("");
    let model = dev.model.as_deref().unwrap_or("").to_lowercase();

    // Check for SD card
    if dev.name.starts_with("mmcblk") {
        return DeviceType::SdCard;
    }

    if !model.contains("ssd") && (model.contains("sd ") || model.contains("sd card")) {
        return DeviceType::SdCard;
    }

    // Check transport type
    match transport {
        "usb" => DeviceType::UsbDrive,
        "nvme" => DeviceType::NvMe,
        "sata" | "ata" => {
            if model.contains("ssd") {
                DeviceType::Ssd
            } else {
                DeviceType::Hdd
            }
        }
        _ => DeviceType::Unknown,
    }
}

pub(super) fn build_device_name(
    dev_name: &str,
    vendor: &Option<String>,
    model: &Option<String>,
) -> String {
    match (vendor, model) {
        (Some(v), Some(m)) => format!("{} {}", v, m),
        (Some(v), None) => v.clone(),
        (None, Some(m)) => m.clone(),
        (None, None) => dev_name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{build_device_name, determine_device_type, LsblkDevice};
    use crate::types::DeviceType;

    #[test]
    fn test_determine_device_type_mmcblk_sd_card() {
        let dev = LsblkDevice {
            name: "mmcblk0".to_string(),
            size: Some(32_000_000_000),
            device_type: Some("disk".to_string()),
            rm: Some(true),
            ro: Some(false),
            tran: None,
            model: None,
            vendor: None,
            hotplug: Some(false),
        };
        assert_eq!(determine_device_type(&dev), DeviceType::SdCard);
    }

    #[test]
    fn test_determine_device_type_usb_transport() {
        let dev = LsblkDevice {
            name: "sdb".to_string(),
            size: Some(64_000_000_000),
            device_type: Some("disk".to_string()),
            rm: Some(true),
            ro: Some(false),
            tran: Some("usb".to_string()),
            model: Some("USB Drive".to_string()),
            vendor: Some("Generic".to_string()),
            hotplug: Some(true),
        };
        assert_eq!(determine_device_type(&dev), DeviceType::UsbDrive);
    }

    #[test]
    fn test_determine_device_type_nvme_transport() {
        let dev = LsblkDevice {
            name: "nvme0n1".to_string(),
            size: Some(512_000_000_000),
            device_type: Some("disk".to_string()),
            rm: Some(false),
            ro: Some(false),
            tran: Some("nvme".to_string()),
            model: Some("Samsung 970 EVO".to_string()),
            vendor: Some("Samsung".to_string()),
            hotplug: Some(false),
        };
        assert_eq!(determine_device_type(&dev), DeviceType::NvMe);
    }

    #[test]
    fn test_determine_device_type_sata_with_ssd_in_model() {
        let dev = LsblkDevice {
            name: "sda".to_string(),
            size: Some(256_000_000_000),
            device_type: Some("disk".to_string()),
            rm: Some(false),
            ro: Some(false),
            tran: Some("sata".to_string()),
            model: Some("Samsung SSD 860".to_string()),
            vendor: Some("Samsung".to_string()),
            hotplug: Some(false),
        };
        assert_eq!(determine_device_type(&dev), DeviceType::Ssd);
    }

    #[test]
    fn test_determine_device_type_sata_without_ssd() {
        let dev = LsblkDevice {
            name: "sda".to_string(),
            size: Some(1_000_000_000_000),
            device_type: Some("disk".to_string()),
            rm: Some(false),
            ro: Some(false),
            tran: Some("sata".to_string()),
            model: Some("WD Blue".to_string()),
            vendor: Some("WD".to_string()),
            hotplug: Some(false),
        };
        assert_eq!(determine_device_type(&dev), DeviceType::Hdd);
    }

    #[test]
    fn test_determine_device_type_ata_transport_with_ssd() {
        let dev = LsblkDevice {
            name: "sda".to_string(),
            size: Some(128_000_000_000),
            device_type: Some("disk".to_string()),
            rm: Some(false),
            ro: Some(false),
            tran: Some("ata".to_string()),
            model: Some("Crucial SSD".to_string()),
            vendor: Some("Crucial".to_string()),
            hotplug: Some(false),
        };
        assert_eq!(determine_device_type(&dev), DeviceType::Ssd);
    }

    #[test]
    fn test_determine_device_type_unknown_transport() {
        let dev = LsblkDevice {
            name: "sdc".to_string(),
            size: Some(64_000_000_000),
            device_type: Some("disk".to_string()),
            rm: Some(true),
            ro: Some(false),
            tran: Some("unknown".to_string()),
            model: None,
            vendor: None,
            hotplug: Some(true),
        };
        assert_eq!(determine_device_type(&dev), DeviceType::Unknown);
    }

    #[test]
    fn test_determine_device_type_sd_in_model_name() {
        let dev = LsblkDevice {
            name: "sdb".to_string(),
            size: Some(32_000_000_000),
            device_type: Some("disk".to_string()),
            rm: Some(true),
            ro: Some(false),
            tran: Some("usb".to_string()),
            model: Some("SD Card Reader".to_string()),
            vendor: None,
            hotplug: Some(true),
        };
        assert_eq!(determine_device_type(&dev), DeviceType::SdCard);
    }

    #[test]
    fn test_determine_device_type_sd_in_model_with_space() {
        let dev = LsblkDevice {
            name: "sdb".to_string(),
            size: Some(32_000_000_000),
            device_type: Some("disk".to_string()),
            rm: Some(true),
            ro: Some(false),
            tran: Some("usb".to_string()),
            model: Some("SD CARD".to_string()),
            vendor: None,
            hotplug: Some(true),
        };
        assert_eq!(determine_device_type(&dev), DeviceType::SdCard);
    }

    #[test]
    fn test_determine_device_type_no_transport() {
        let dev = LsblkDevice {
            name: "sdb".to_string(),
            size: Some(32_000_000_000),
            device_type: Some("disk".to_string()),
            rm: Some(true),
            ro: Some(false),
            tran: None,
            model: None,
            vendor: None,
            hotplug: Some(true),
        };
        assert_eq!(determine_device_type(&dev), DeviceType::Unknown);
    }

    #[test]
    fn test_build_device_name_all_combinations() {
        // Test various vendor/model combinations
        assert_eq!(build_device_name("sda", &None, &None), "sda");
        assert_eq!(build_device_name("sdb", &Some("V".to_string()), &None), "V");
        assert_eq!(build_device_name("sdc", &None, &Some("M".to_string())), "M");
        assert_eq!(
            build_device_name("sdd", &Some("V".to_string()), &Some("M".to_string())),
            "V M"
        );
    }
}
