//! macOS block device enumeration via `diskutil`.

use super::super::*;
use crate::error::Error;
use serde::Deserialize;
use std::process::Command;

#[derive(Debug, Deserialize)]
struct DiskUtilList {
    #[serde(rename = "AllDisksAndPartitions")]
    all_disks_and_partitions: Vec<DiskEntry>,
}

#[derive(Debug, Deserialize)]
struct DiskEntry {
    #[serde(rename = "DeviceIdentifier")]
    device_identifier: String,
    #[serde(rename = "Size", default)]
    _size: u64,
    #[serde(rename = "Content", default)]
    _content: Option<String>,
    #[serde(rename = "Partitions", default)]
    _partitions: Vec<PartitionEntry>,
}

#[derive(Debug, Deserialize)]
struct PartitionEntry {
    #[serde(rename = "DeviceIdentifier")]
    _device_identifier: String,
    #[serde(rename = "Size", default)]
    _size: u64,
}

#[derive(Debug, Deserialize)]
pub(super) struct DiskUtilInfo {
    #[serde(rename = "Ejectable", default)]
    pub(super) ejectable: bool,
    #[serde(rename = "Removable", default)]
    pub(super) removable: bool,
    #[serde(rename = "RemovableMedia", default)]
    pub(super) removable_media: bool,
    #[serde(rename = "Internal", default)]
    pub(super) internal: bool,
    #[serde(rename = "SolidState", default)]
    pub(super) solid_state: bool,
    #[serde(rename = "MediaName", default)]
    pub(super) media_name: Option<String>,
    #[serde(rename = "IORegistryEntryName", default)]
    pub(super) io_registry_entry_name: Option<String>,
    #[serde(rename = "DeviceNode", default)]
    pub(super) device_node: Option<String>,
    #[serde(rename = "Size", default)]
    pub(super) size: u64,
    #[serde(rename = "BusProtocol", default)]
    pub(super) bus_protocol: Option<String>,
    #[serde(rename = "MediaType", default)]
    pub(super) media_type: Option<String>,
}

pub async fn list_devices() -> Result<Vec<BlockDevice>> {
    // Get list of all disks using diskutil
    let output = Command::new("diskutil")
        .args(["list", "-plist"])
        .output()
        .map_err(Error::Io)?;

    if !output.status.success() {
        return Err(Error::DeviceNotFound(format!(
            "diskutil failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    let disk_list: DiskUtilList =
        plist::from_bytes(&output.stdout).map_err(|e| Error::InvalidConfig(e.to_string()))?;

    let mut devices = Vec::new();

    // Get detailed info for each whole disk (not partitions)
    for disk in disk_list.all_disks_and_partitions {
        // Skip synthesized disks (APFS containers, etc.)
        if disk.device_identifier.starts_with("synthesized") {
            continue;
        }

        // Get detailed disk info
        let info_output = Command::new("diskutil")
            .args(["info", "-plist", &disk.device_identifier])
            .output()
            .map_err(Error::Io)?;

        if !info_output.status.success() {
            continue;
        }

        let disk_info: DiskUtilInfo = match plist::from_bytes(&info_output.stdout) {
            Ok(info) => info,
            Err(_) => continue,
        };

        // Filter: only include removable/ejectable external media
        // Skip internal drives
        if disk_info.internal && !disk_info.removable_media {
            continue;
        }

        // Must be ejectable or removable
        if !disk_info.ejectable && !disk_info.removable && !disk_info.removable_media {
            continue;
        }

        // Skip very small devices (< 1GB) - likely not real storage
        if disk_info.size < 1_000_000_000 {
            continue;
        }

        // Determine device type based on bus protocol and other properties
        let device_type = determine_device_type(&disk_info);

        // Build the device name
        let name = disk_info
            .media_name
            .clone()
            .or(disk_info.io_registry_entry_name.clone())
            .unwrap_or_else(|| disk.device_identifier.clone());

        // Extract vendor and model from media name if possible
        let (vendor, model) = parse_media_name(&name);

        let device_path = disk_info
            .device_node
            .unwrap_or_else(|| format!("/dev/{}", disk.device_identifier));

        devices.push(BlockDevice {
            id: device_path,
            name,
            size: disk_info.size,
            device_type,
            removable: disk_info.removable || disk_info.removable_media || disk_info.ejectable,
            model,
            vendor,
        });
    }

    Ok(devices)
}

pub(super) fn determine_device_type(info: &DiskUtilInfo) -> DeviceType {
    let bus = info.bus_protocol.as_deref().unwrap_or("");
    let media = info.media_type.as_deref().unwrap_or("");

    // Check for SD card
    if media.to_lowercase().contains("sd")
        || info
            .media_name
            .as_ref()
            .map(|n| n.to_lowercase().contains("sd"))
            .unwrap_or(false)
    {
        return DeviceType::SdCard;
    }

    // Check bus protocol
    match bus {
        "USB" => DeviceType::UsbDrive,
        "PCI-Express" | "PCI" => {
            if info.solid_state {
                DeviceType::NvMe
            } else {
                DeviceType::Ssd
            }
        }
        "SATA" => {
            if info.solid_state {
                DeviceType::Ssd
            } else {
                DeviceType::Hdd
            }
        }
        _ => {
            if info.solid_state {
                DeviceType::Ssd
            } else {
                DeviceType::Unknown
            }
        }
    }
}

pub(crate) fn parse_media_name(name: &str) -> (Option<String>, Option<String>) {
    // Common vendor prefixes
    let vendors = [
        "SanDisk",
        "Samsung",
        "Kingston",
        "Lexar",
        "PNY",
        "Transcend",
        "Sony",
        "Toshiba",
        "Western Digital",
        "WD",
        "Seagate",
        "Crucial",
        "Micron",
    ];

    let name_lower = name.to_lowercase();

    for vendor in vendors {
        if let Some(pos) = name_lower.find(&vendor.to_lowercase()) {
            // Remove the vendor from the name (case-insensitive)
            let model = format!("{}{}", &name[..pos], &name[pos + vendor.len()..])
                .trim()
                .trim_start_matches(&[' ', '-', '_'][..])
                .to_string();
            return (
                Some(vendor.to_string()),
                if model.is_empty() { None } else { Some(model) },
            );
        }
    }

    (None, Some(name.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{determine_device_type, parse_media_name, DiskUtilInfo};
    use crate::types::DeviceType;

    #[test]
    fn test_parse_media_name_with_vendor() {
        let (vendor, model) = parse_media_name("SanDisk Ultra");
        assert_eq!(vendor, Some("SanDisk".to_string()));
        assert_eq!(model, Some("Ultra".to_string()));
    }

    #[test]
    fn test_parse_media_name_vendor_only() {
        let (vendor, model) = parse_media_name("Samsung");
        assert_eq!(vendor, Some("Samsung".to_string()));
        assert_eq!(model, None);
    }

    #[test]
    fn test_parse_media_name_no_vendor() {
        let (vendor, model) = parse_media_name("Unknown Device");
        assert_eq!(vendor, None);
        assert_eq!(model, Some("Unknown Device".to_string()));
    }

    #[test]
    fn test_parse_media_name_case_insensitive() {
        let (vendor, model) = parse_media_name("SANDISK EXTREME PRO");
        assert_eq!(vendor, Some("SanDisk".to_string()));
        assert_eq!(model, Some("EXTREME PRO".to_string()));
    }

    #[test]
    fn test_determine_device_type_sd_card_by_media_type() {
        let info = DiskUtilInfo {
            ejectable: true,
            removable: true,
            removable_media: true,
            internal: false,
            solid_state: true,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 32_000_000_000,
            bus_protocol: Some("USB".to_string()),
            media_type: Some("SD Card".to_string()),
        };
        assert_eq!(determine_device_type(&info), DeviceType::SdCard);
    }

    #[test]
    fn test_determine_device_type_sd_card_by_media_name() {
        let info = DiskUtilInfo {
            ejectable: true,
            removable: true,
            removable_media: true,
            internal: false,
            solid_state: true,
            media_name: Some("SD Card Reader".to_string()),
            io_registry_entry_name: None,
            device_node: None,
            size: 32_000_000_000,
            bus_protocol: None,
            media_type: None,
        };
        assert_eq!(determine_device_type(&info), DeviceType::SdCard);
    }

    #[test]
    fn test_determine_device_type_usb_drive() {
        let info = DiskUtilInfo {
            ejectable: true,
            removable: true,
            removable_media: true,
            internal: false,
            solid_state: false,
            media_name: Some("USB Drive".to_string()),
            io_registry_entry_name: None,
            device_node: None,
            size: 64_000_000_000,
            bus_protocol: Some("USB".to_string()),
            media_type: None,
        };
        assert_eq!(determine_device_type(&info), DeviceType::UsbDrive);
    }

    #[test]
    fn test_determine_device_type_nvme_pcie() {
        let info = DiskUtilInfo {
            ejectable: false,
            removable: false,
            removable_media: false,
            internal: true,
            solid_state: true,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 500_000_000_000,
            bus_protocol: Some("PCI-Express".to_string()),
            media_type: None,
        };
        assert_eq!(determine_device_type(&info), DeviceType::NvMe);
    }

    #[test]
    fn test_determine_device_type_ssd_pcie() {
        let info = DiskUtilInfo {
            ejectable: false,
            removable: false,
            removable_media: false,
            internal: true,
            solid_state: false,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 500_000_000_000,
            bus_protocol: Some("PCI".to_string()),
            media_type: None,
        };
        assert_eq!(determine_device_type(&info), DeviceType::Ssd);
    }

    #[test]
    fn test_determine_device_type_ssd_sata() {
        let info = DiskUtilInfo {
            ejectable: false,
            removable: false,
            removable_media: false,
            internal: true,
            solid_state: true,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 256_000_000_000,
            bus_protocol: Some("SATA".to_string()),
            media_type: None,
        };
        assert_eq!(determine_device_type(&info), DeviceType::Ssd);
    }

    #[test]
    fn test_determine_device_type_hdd_sata() {
        let info = DiskUtilInfo {
            ejectable: false,
            removable: false,
            removable_media: false,
            internal: true,
            solid_state: false,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 1_000_000_000_000,
            bus_protocol: Some("SATA".to_string()),
            media_type: None,
        };
        assert_eq!(determine_device_type(&info), DeviceType::Hdd);
    }

    #[test]
    fn test_determine_device_type_unknown_protocol_solid_state() {
        let info = DiskUtilInfo {
            ejectable: false,
            removable: false,
            removable_media: false,
            internal: true,
            solid_state: true,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 128_000_000_000,
            bus_protocol: Some("Unknown".to_string()),
            media_type: None,
        };
        assert_eq!(determine_device_type(&info), DeviceType::Ssd);
    }

    #[test]
    fn test_determine_device_type_unknown() {
        let info = DiskUtilInfo {
            ejectable: false,
            removable: false,
            removable_media: false,
            internal: true,
            solid_state: false,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 128_000_000_000,
            bus_protocol: None,
            media_type: None,
        };
        assert_eq!(determine_device_type(&info), DeviceType::Unknown);
    }

    #[test]
    fn test_parse_media_name_with_various_vendors() {
        // Test all vendor variations
        let vendors_to_test = [
            ("Kingston DataTraveler", "Kingston", "DataTraveler"),
            ("Lexar JumpDrive", "Lexar", "JumpDrive"),
            ("PNY USB Drive", "PNY", "USB Drive"),
            ("Transcend JetFlash", "Transcend", "JetFlash"),
            ("Sony Storage", "Sony", "Storage"),
            ("Toshiba Drive", "Toshiba", "Drive"),
            (
                "Western Digital My Passport",
                "Western Digital",
                "My Passport",
            ),
            ("WD Elements", "WD", "Elements"),
            ("Seagate Backup Plus", "Seagate", "Backup Plus"),
            ("Crucial X6", "Crucial", "X6"),
            ("Micron M600", "Micron", "M600"),
        ];

        for (input, expected_vendor, expected_model) in vendors_to_test {
            let (vendor, model) = parse_media_name(input);
            assert_eq!(
                vendor,
                Some(expected_vendor.to_string()),
                "Failed for input: {}",
                input
            );
            assert_eq!(
                model,
                Some(expected_model.to_string()),
                "Failed for input: {}",
                input
            );
        }
    }

    #[test]
    fn test_parse_media_name_vendor_at_end() {
        let (vendor, model) = parse_media_name("Ultra SanDisk");
        assert_eq!(vendor, Some("SanDisk".to_string()));
        assert_eq!(model, Some("Ultra".to_string()));
    }

    #[test]
    fn test_parse_media_name_with_hyphens_and_underscores() {
        let (vendor, model) = parse_media_name("SanDisk-Ultra-Pro");
        assert_eq!(vendor, Some("SanDisk".to_string()));
        assert_eq!(model, Some("Ultra-Pro".to_string()));
    }

    #[test]
    fn test_parse_media_name_empty_model_after_vendor() {
        let (vendor, model) = parse_media_name("SanDisk   ");
        assert_eq!(vendor, Some("SanDisk".to_string()));
        assert_eq!(model, None);
    }

    #[test]
    fn test_determine_device_type_with_no_bus_protocol() {
        let info = DiskUtilInfo {
            ejectable: true,
            removable: true,
            removable_media: true,
            internal: false,
            solid_state: false,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 32_000_000_000,
            bus_protocol: None,
            media_type: None,
        };
        assert_eq!(determine_device_type(&info), DeviceType::Unknown);
    }

    #[test]
    fn test_determine_device_type_empty_bus_protocol() {
        let info = DiskUtilInfo {
            ejectable: true,
            removable: true,
            removable_media: true,
            internal: false,
            solid_state: false,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 32_000_000_000,
            bus_protocol: Some("".to_string()),
            media_type: None,
        };
        assert_eq!(determine_device_type(&info), DeviceType::Unknown);
    }

    #[test]
    fn test_determine_device_type_sd_lowercase_in_media_type() {
        let info = DiskUtilInfo {
            ejectable: true,
            removable: true,
            removable_media: true,
            internal: false,
            solid_state: true,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 32_000_000_000,
            bus_protocol: None,
            media_type: Some("sd".to_string()),
        };
        assert_eq!(determine_device_type(&info), DeviceType::SdCard);
    }

    #[test]
    fn test_determine_device_type_sd_uppercase_in_media_name() {
        let info = DiskUtilInfo {
            ejectable: true,
            removable: true,
            removable_media: true,
            internal: false,
            solid_state: true,
            media_name: Some("SD READER".to_string()),
            io_registry_entry_name: None,
            device_node: None,
            size: 32_000_000_000,
            bus_protocol: None,
            media_type: None,
        };
        assert_eq!(determine_device_type(&info), DeviceType::SdCard);
    }

    #[test]
    fn test_parse_media_name_with_underscores() {
        let (vendor, model) = parse_media_name("SanDisk_Ultra_Pro");
        assert_eq!(vendor, Some("SanDisk".to_string()));
        assert_eq!(model, Some("Ultra_Pro".to_string()));
    }

    #[test]
    fn test_parse_media_name_empty_string() {
        let (vendor, model) = parse_media_name("");
        assert_eq!(vendor, None);
        assert_eq!(model, Some("".to_string()));
    }
}
