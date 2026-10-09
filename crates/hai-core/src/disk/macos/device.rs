//! macOS block device enumeration via `diskutil`.

use crate::disk::macos_safety::{self, DiskInfo as DiskUtilInfo};
use crate::disk::{mentions_sd_card, normalize_serial};
use crate::error::{Error, Result};
use crate::types::{BlockDevice, DeviceType};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
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

fn disk_info(device: &str) -> Result<DiskUtilInfo> {
    let output = Command::new("diskutil")
        .args(["info", "-plist", device])
        .output()?;
    if !output.status.success() {
        return Err(Error::DeviceNotFound(format!(
            "Cannot inspect {device}: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    plist::from_bytes(&output.stdout).map_err(|e| Error::InvalidConfig(e.to_string()))
}

fn system_disks() -> Result<HashSet<String>> {
    let mut mounts = vec!["/"];
    if Path::new("/System/Volumes/Data").try_exists()? {
        mounts.push("/System/Volumes/Data");
    }
    macos_safety::system_disks(&mounts, disk_info)
}

/// This gate also runs in the writer, before unmounting or requesting access.
pub(super) fn validate_flash_target(device_id: &str) -> Result<()> {
    let disk_id = device_id.strip_prefix("/dev/disk").ok_or_else(|| {
        Error::PermissionDenied("The flash target must be a whole /dev/diskN device".into())
    })?;
    if disk_id.is_empty() || !disk_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Error::PermissionDenied(
            "The flash target must be a whole /dev/diskN device".into(),
        ));
    }
    let system_disks = system_disks()?;
    let disk: DiskUtilInfo = disk_info(device_id)?;
    if device_id != format!("/dev/{}", disk.device_identifier) {
        return Err(Error::PermissionDenied(
            "diskutil returned an inconsistent identity for the flash target".into(),
        ));
    }
    disk.validate_target(&system_disks)
}

pub async fn list_devices() -> Result<Vec<BlockDevice>> {
    list_devices_sync()
}

pub(super) fn list_devices_sync() -> Result<Vec<BlockDevice>> {
    let system_disks = system_disks()?;
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

    let mut devices = devices_from_list(disk_list, &system_disks, disk_info);
    // Only storage-characteristic serials are used, never the host or a USB
    // hub's serial, nor a UUID that flashing would overwrite. A failure must
    // not look like "no serial": the recheck before writing would then report
    // a changed drive that never changed.
    let serials = storage_serials()?;
    for device in &mut devices {
        device.serial = serials.get(device.id.trim_start_matches("/dev/")).cloned();
    }
    Ok(devices)
}

fn storage_serials() -> Result<HashMap<String, String>> {
    let output = Command::new("ioreg")
        // SCSI drivers may publish the serial above IOBlockStorageDevice.
        .args([
            "-a",
            "-l",
            "-r",
            "-k",
            "Device Characteristics",
            "-p",
            "IOService",
        ])
        .output()?;
    if !output.status.success() {
        return Err(serials_unavailable());
    }
    serials_from_ioreg(&output.stdout)
}

fn serials_unavailable() -> Error {
    Error::InvalidConfig("Could not read the drive serial numbers from the system.".into())
}

fn serials_from_ioreg(output: &[u8]) -> Result<HashMap<String, String>> {
    let roots: Vec<plist::Value> = plist::from_bytes(output).map_err(|_| serials_unavailable())?;
    let mut serials = HashMap::new();
    for root in roots {
        collect_serials(&root, None, &mut serials);
    }
    Ok(serials)
}

fn collect_serials(
    node: &plist::Value,
    inherited: Option<&String>,
    serials: &mut HashMap<String, String>,
) {
    let Some(properties) = node.as_dictionary() else {
        return;
    };
    let serial = properties
        .get("Device Characteristics")
        .and_then(plist::Value::as_dictionary)
        .and_then(|characteristics| characteristics.get("Serial Number"))
        .and_then(plist::Value::as_string);
    // Normalize before inheriting: a blank serial on a middle node must not
    // hide the real one reported further up
    let serial = normalize_serial(serial);
    let serial = serial.as_ref().or(inherited);
    if properties.get("Whole").and_then(plist::Value::as_boolean) == Some(true) {
        if let (Some(name), Some(serial)) = (
            properties.get("BSD Name").and_then(plist::Value::as_string),
            serial,
        ) {
            serials.insert(name.to_string(), serial.clone());
        }
    }
    if let Some(children) = properties
        .get("IORegistryEntryChildren")
        .and_then(plist::Value::as_array)
    {
        for child in children {
            collect_serials(child, serial, serials);
        }
    }
}

fn devices_from_list(
    disk_list: DiskUtilList,
    system_disks: &HashSet<String>,
    mut info: impl FnMut(&str) -> Result<DiskUtilInfo>,
) -> Vec<BlockDevice> {
    let mut devices = Vec::new();

    // Get detailed info for each whole disk (not partitions)
    for disk in disk_list.all_disks_and_partitions {
        let disk_info = match info(&disk.device_identifier) {
            Ok(info) => info,
            Err(_) => continue,
        };
        if disk_info.validate_target(system_disks).is_err() {
            continue;
        }

        // `Internal` is deliberately not consulted: a built-in SD slot is
        // internal yet holds removable media, and external USB SSDs report
        // fixed media but are ejectable.
        let removable = disk_info.removable || disk_info.removable_media || disk_info.ejectable;

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
            removable,
            model,
            vendor,
            serial: None,
        });
    }

    devices
}

pub(super) fn determine_device_type(info: &DiskUtilInfo) -> DeviceType {
    let bus = info.bus_protocol.as_deref().unwrap_or("");
    let media = info.media_type.as_deref().unwrap_or("");

    // Check for SD card
    if mentions_sd_card(media)
        || info
            .media_name
            .as_deref()
            .map(mentions_sd_card)
            .unwrap_or(false)
    {
        return DeviceType::SdCard;
    }

    // Check bus protocol
    match bus {
        "USB" => DeviceType::UsbDrive,
        "PCI-Express" | "PCI" => {
            if info.solid_state {
                DeviceType::Nvme
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
    #[test]
    fn storage_serial_follows_only_its_own_whole_media() {
        let tree: plist::Value = plist::from_bytes(br#"<plist version="1.0"><dict>
          <key>IORegistryEntryChildren</key><array>
            <dict><key>Device Characteristics</key><dict><key>Serial Number</key><string> STICK-A </string></dict>
              <key>IORegistryEntryChildren</key><array><dict>
                <key>BSD Name</key><string>disk2</string><key>Whole</key><true/>
                <key>UUID</key><string>changes-when-flashed</string>
                <key>IORegistryEntryChildren</key><array><dict>
                  <key>BSD Name</key><string>disk2s1</string><key>Whole</key><false/>
                </dict></array>
              </dict></array>
            </dict>
            <dict><key>BSD Name</key><string>disk3</string><key>Whole</key><true/>
              <key>UUID</key><string>not-a-hardware-serial</string>
            </dict>
            <dict><key>Device Characteristics</key><dict><key>Serial Number</key><string>STICK-B</string></dict>
              <key>IORegistryEntryChildren</key><array><dict>
                <key>BSD Name</key><string>disk4</string><key>Whole</key><true/>
              </dict></array>
            </dict>
          </array>
        </dict></plist>"#).unwrap();
        let mut serials = std::collections::HashMap::new();
        super::collect_serials(&tree, None, &mut serials);
        assert_eq!(serials.len(), 2);
        assert_eq!(serials["disk2"], "STICK-A");
        assert_eq!(serials["disk4"], "STICK-B");
    }

    #[test]
    fn blank_serial_on_a_middle_node_keeps_the_inherited_one() {
        let tree: plist::Value = plist::from_bytes(br#"<plist version="1.0"><dict>
          <key>Device Characteristics</key><dict><key>Serial Number</key><string>ABC123</string></dict>
          <key>IORegistryEntryChildren</key><array><dict>
            <key>Device Characteristics</key><dict><key>Serial Number</key><string>   </string></dict>
            <key>IORegistryEntryChildren</key><array><dict>
              <key>BSD Name</key><string>disk4</string><key>Whole</key><true/>
            </dict></array>
          </dict></array>
        </dict></plist>"#).unwrap();
        let mut serials = std::collections::HashMap::new();
        super::collect_serials(&tree, None, &mut serials);
        assert_eq!(serials["disk4"], "ABC123");
    }

    #[test]
    fn unreadable_ioreg_output_is_an_error_not_missing_serials() {
        assert!(super::serials_from_ioreg(b"not a plist").is_err());
        let serials = super::serials_from_ioreg(br#"<plist version="1.0"><array><dict>
          <key>Device Characteristics</key><dict><key>Serial Number</key><string>STICK-A</string></dict>
          <key>IORegistryEntryChildren</key><array><dict>
            <key>BSD Name</key><string>disk2</string><key>Whole</key><true/>
          </dict></array>
        </dict></array></plist>"#)
        .unwrap();
        assert_eq!(serials["disk2"], "STICK-A");
    }

    use super::{
        determine_device_type, devices_from_list, parse_media_name, validate_flash_target,
        DiskUtilInfo, DiskUtilList,
    };
    use crate::types::DeviceType;
    use std::collections::HashSet;

    #[test]
    fn enumeration_filters_virtual_and_system_disks_with_the_backend_gate() {
        for system_disks in [HashSet::new(), HashSet::from(["disk2".into()])] {
            let list: DiskUtilList =
                plist::from_bytes(include_bytes!("fixtures/list.plist")).unwrap();
            let devices = devices_from_list(list, &system_disks, |device| {
                let xml = match device {
                    "disk2" => include_str!("fixtures/usb-disk.plist"),
                    "disk3" => include_str!("fixtures/apfs-container.plist"),
                    "disk4" => include_str!("fixtures/disk-image.plist"),
                    "disk5" => return Err(crate::error::Error::DeviceNotFound(device.into())),
                    _ => panic!("unexpected device {device}"),
                };
                Ok(plist::from_bytes(xml.as_bytes()).unwrap())
            });
            if system_disks.is_empty() {
                assert_eq!(devices.len(), 1);
                assert_eq!(devices[0].id, "/dev/disk2");
            } else {
                assert!(devices.is_empty());
            }
        }
    }

    #[test]
    fn parses_safety_and_display_metadata_from_the_same_plist() {
        let details: DiskUtilInfo =
            plist::from_bytes(include_bytes!("fixtures/usb-disk.plist")).unwrap();
        assert_eq!(details.device_identifier, "disk2");
        assert_eq!(details.device_node.as_deref(), Some("/dev/disk2"));
        assert_eq!(details.size, 500_000_000_000);
        assert!(details.ejectable);
        assert!(details.validate_target(&Default::default()).is_ok());
    }

    #[test]
    fn rejects_non_whole_disk_paths_before_inspecting_or_unmounting() {
        for path in [
            "disk2",
            "/dev/rdisk2",
            "/dev/disk2s2",
            "/dev/disk",
            "/tmp/disk2",
        ] {
            let error = validate_flash_target(path).unwrap_err();
            assert!(error.to_string().contains("whole /dev/diskN"));
        }
    }

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
            solid_state: true,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 32_000_000_000,
            bus_protocol: Some("USB".to_string()),
            media_type: Some("SD Card".to_string()),
            ..Default::default()
        };
        assert_eq!(determine_device_type(&info), DeviceType::SdCard);
    }

    #[test]
    fn test_determine_device_type_sd_card_by_media_name() {
        let info = DiskUtilInfo {
            ejectable: true,
            removable: true,
            removable_media: true,
            solid_state: true,
            media_name: Some("SD Card Reader".to_string()),
            io_registry_entry_name: None,
            device_node: None,
            size: 32_000_000_000,
            bus_protocol: None,
            media_type: None,
            ..Default::default()
        };
        assert_eq!(determine_device_type(&info), DeviceType::SdCard);
    }

    #[test]
    fn test_determine_device_type_usb_drive() {
        let info = DiskUtilInfo {
            ejectable: true,
            removable: true,
            removable_media: true,
            solid_state: false,
            media_name: Some("USB Drive".to_string()),
            io_registry_entry_name: None,
            device_node: None,
            size: 64_000_000_000,
            bus_protocol: Some("USB".to_string()),
            media_type: None,
            ..Default::default()
        };
        assert_eq!(determine_device_type(&info), DeviceType::UsbDrive);
    }

    #[test]
    fn test_determine_device_type_portable_ssd_is_not_sd_card() {
        // "SSD" contains "sd" as a substring; only whole-word "SD" counts.
        let info = DiskUtilInfo {
            ejectable: true,
            removable: true,
            removable_media: true,
            solid_state: true,
            media_name: Some("Samsung Portable SSD T7".to_string()),
            io_registry_entry_name: None,
            device_node: None,
            size: 500_000_000_000,
            bus_protocol: Some("USB".to_string()),
            media_type: Some("SSD".to_string()),
            ..Default::default()
        };
        assert_eq!(determine_device_type(&info), DeviceType::UsbDrive);
    }

    #[test]
    fn test_determine_device_type_sdxc_is_sd_card() {
        let info = DiskUtilInfo {
            ejectable: true,
            removable: true,
            removable_media: true,
            solid_state: true,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 128_000_000_000,
            bus_protocol: Some("USB".to_string()),
            media_type: Some("SDXC".to_string()),
            ..Default::default()
        };
        assert_eq!(determine_device_type(&info), DeviceType::SdCard);
    }

    #[test]
    fn test_determine_device_type_nvme_pcie() {
        let info = DiskUtilInfo {
            ejectable: false,
            removable: false,
            removable_media: false,
            solid_state: true,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 500_000_000_000,
            bus_protocol: Some("PCI-Express".to_string()),
            media_type: None,
            ..Default::default()
        };
        assert_eq!(determine_device_type(&info), DeviceType::Nvme);
    }

    #[test]
    fn test_determine_device_type_ssd_pcie() {
        let info = DiskUtilInfo {
            ejectable: false,
            removable: false,
            removable_media: false,
            solid_state: false,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 500_000_000_000,
            bus_protocol: Some("PCI".to_string()),
            media_type: None,
            ..Default::default()
        };
        assert_eq!(determine_device_type(&info), DeviceType::Ssd);
    }

    #[test]
    fn test_determine_device_type_ssd_sata() {
        let info = DiskUtilInfo {
            ejectable: false,
            removable: false,
            removable_media: false,
            solid_state: true,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 256_000_000_000,
            bus_protocol: Some("SATA".to_string()),
            media_type: None,
            ..Default::default()
        };
        assert_eq!(determine_device_type(&info), DeviceType::Ssd);
    }

    #[test]
    fn test_determine_device_type_hdd_sata() {
        let info = DiskUtilInfo {
            ejectable: false,
            removable: false,
            removable_media: false,
            solid_state: false,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 1_000_000_000_000,
            bus_protocol: Some("SATA".to_string()),
            media_type: None,
            ..Default::default()
        };
        assert_eq!(determine_device_type(&info), DeviceType::Hdd);
    }

    #[test]
    fn test_determine_device_type_unknown_protocol_solid_state() {
        let info = DiskUtilInfo {
            ejectable: false,
            removable: false,
            removable_media: false,
            solid_state: true,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 128_000_000_000,
            bus_protocol: Some("Unknown".to_string()),
            media_type: None,
            ..Default::default()
        };
        assert_eq!(determine_device_type(&info), DeviceType::Ssd);
    }

    #[test]
    fn test_determine_device_type_unknown() {
        let info = DiskUtilInfo {
            ejectable: false,
            removable: false,
            removable_media: false,
            solid_state: false,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 128_000_000_000,
            bus_protocol: None,
            media_type: None,
            ..Default::default()
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
            solid_state: false,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 32_000_000_000,
            bus_protocol: None,
            media_type: None,
            ..Default::default()
        };
        assert_eq!(determine_device_type(&info), DeviceType::Unknown);
    }

    #[test]
    fn test_determine_device_type_empty_bus_protocol() {
        let info = DiskUtilInfo {
            ejectable: true,
            removable: true,
            removable_media: true,
            solid_state: false,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 32_000_000_000,
            bus_protocol: Some("".to_string()),
            media_type: None,
            ..Default::default()
        };
        assert_eq!(determine_device_type(&info), DeviceType::Unknown);
    }

    #[test]
    fn test_determine_device_type_sd_lowercase_in_media_type() {
        let info = DiskUtilInfo {
            ejectable: true,
            removable: true,
            removable_media: true,
            solid_state: true,
            media_name: None,
            io_registry_entry_name: None,
            device_node: None,
            size: 32_000_000_000,
            bus_protocol: None,
            media_type: Some("sd".to_string()),
            ..Default::default()
        };
        assert_eq!(determine_device_type(&info), DeviceType::SdCard);
    }

    #[test]
    fn test_determine_device_type_sd_uppercase_in_media_name() {
        let info = DiskUtilInfo {
            ejectable: true,
            removable: true,
            removable_media: true,
            solid_state: true,
            media_name: Some("SD READER".to_string()),
            io_registry_entry_name: None,
            device_node: None,
            size: 32_000_000_000,
            bus_protocol: None,
            media_type: None,
            ..Default::default()
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
