//! macOS block device enumeration via `diskutil`.

use crate::disk::macos_safety::{self, DiskInfo as DiskUtilInfo};
use crate::disk::{find_vendor, mentions_sd_card, normalize_serial};
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
    let not_whole_disk =
        || Error::PermissionDenied(crate::message!("backend.disk.not_whole_disk_device"));
    let disk_id = device_id
        .strip_prefix("/dev/disk")
        .ok_or_else(not_whole_disk)?;
    if disk_id.is_empty() || !disk_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(not_whole_disk());
    }
    let system_disks = system_disks()?;
    let disk: DiskUtilInfo = disk_info(device_id)?;
    if device_id != format!("/dev/{}", disk.device_identifier) {
        return Err(Error::PermissionDenied(crate::message!(
            "backend.disk.inconsistent_identity"
        )));
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

    for vendor in vendors {
        if let Some(found) = find_vendor(name, vendor) {
            // Remove the vendor from the name (case-insensitive)
            let model = format!("{}{}", &name[..found.start], &name[found.end..])
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
    fn determine_device_type_by_media_then_bus() {
        use DeviceType::{Hdd, Nvme, SdCard, Ssd, Unknown, UsbDrive};
        for (label, bus, solid_state, media_type, media_name, expected) in [
            ("SD media type", Some("USB"), true, Some("SD"), None, SdCard),
            ("SD media name", None, true, None, Some("SD READER"), SdCard),
            ("USB", Some("USB"), false, None, Some("USB Drive"), UsbDrive),
            (
                "portable SSD",
                Some("USB"),
                true,
                Some("SSD"),
                Some("Samsung Portable SSD T7"),
                UsbDrive,
            ),
            ("PCIe SSD", Some("PCI-Express"), true, None, None, Nvme),
            ("PCI, not solid state", Some("PCI"), false, None, None, Ssd),
            ("SATA SSD", Some("SATA"), true, None, None, Ssd),
            ("SATA HDD", Some("SATA"), false, None, None, Hdd),
            ("other bus, SSD", Some("Unknown"), true, None, None, Ssd),
            ("no bus", None, false, None, None, Unknown),
            ("empty bus", Some(""), false, None, None, Unknown),
        ] {
            let info = DiskUtilInfo {
                bus_protocol: bus.map(Into::into),
                solid_state,
                media_type: media_type.map(Into::into),
                media_name: media_name.map(Into::into),
                ..Default::default()
            };
            assert_eq!(determine_device_type(&info), expected, "{label}");
        }
    }

    #[test]
    fn parse_media_name_splits_off_a_known_vendor() {
        for (name, vendor, model) in [
            ("SanDisk Ultra", Some("SanDisk"), Some("Ultra")),
            ("SANDISK EXTREME PRO", Some("SanDisk"), Some("EXTREME PRO")),
            ("Ultra SanDisk", Some("SanDisk"), Some("Ultra")),
            ("SanDisk-Ultra-Pro", Some("SanDisk"), Some("Ultra-Pro")),
            ("SanDisk_Ultra_Pro", Some("SanDisk"), Some("Ultra_Pro")),
            ("Samsung", Some("Samsung"), None),
            ("SanDisk   ", Some("SanDisk"), None),
            ("Kingston DT Exodia", Some("Kingston"), Some("DT Exodia")),
            ("Lexar JumpDrive", Some("Lexar"), Some("JumpDrive")),
            ("PNY USB Drive", Some("PNY"), Some("USB Drive")),
            ("Transcend JetFlash", Some("Transcend"), Some("JetFlash")),
            ("Sony Storage", Some("Sony"), Some("Storage")),
            ("Toshiba Drive", Some("Toshiba"), Some("Drive")),
            ("Western Digital Red", Some("Western Digital"), Some("Red")),
            ("WD Elements", Some("WD"), Some("Elements")),
            ("Seagate Backup Plus", Some("Seagate"), Some("Backup Plus")),
            ("Crucial X6", Some("Crucial"), Some("X6")),
            ("Micron M600", Some("Micron"), Some("M600")),
            ("Unknown Device", None, Some("Unknown Device")),
            ("", None, Some("")),
            // "İ" grows when lowercased, so offsets from a lowercased copy don't fit.
            ("İSanDisk Ultra", Some("SanDisk"), Some("İ Ultra")),
            // The Kelvin sign lowercases to an ASCII "k", but it is not a "K".
            ("\u{212A}ingston", None, Some("\u{212A}ingston")),
        ] {
            let (found_vendor, found_model) = parse_media_name(name);
            assert_eq!(
                (found_vendor.as_deref(), found_model.as_deref()),
                (vendor, model),
                "{name:?}"
            );
        }
    }
}
