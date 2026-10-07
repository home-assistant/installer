//! Diskutil safety metadata and physical backing resolution, tested on every OS.

use crate::error::{Error, Result};
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Debug, Default, Deserialize)]
pub(super) struct DiskInfo {
    #[serde(rename = "DeviceIdentifier")]
    pub device_identifier: String,
    #[serde(rename = "WholeDisk", default)]
    pub whole_disk: bool,
    #[serde(rename = "VirtualOrPhysical", default)]
    pub virtual_or_physical: Option<String>,
    #[serde(rename = "BusProtocol", default)]
    pub bus_protocol: Option<String>,
    #[serde(rename = "ParentWholeDisk", default)]
    pub parent_whole_disk: Option<String>,
    #[serde(rename = "APFSContainerReference", default)]
    pub apfs_container_reference: Option<String>,
    #[serde(rename = "APFSPhysicalStores", default)]
    pub apfs_physical_stores: Vec<PhysicalStore>,
    #[serde(rename = "Removable", default)]
    pub removable: bool,
    #[serde(rename = "RemovableMedia", default)]
    pub removable_media: bool,
    #[serde(rename = "Ejectable", default)]
    pub ejectable: bool,
    #[serde(rename = "SolidState", default)]
    pub solid_state: bool,
    #[serde(rename = "MediaName", default)]
    pub media_name: Option<String>,
    #[serde(rename = "IORegistryEntryName", default)]
    pub io_registry_entry_name: Option<String>,
    #[serde(rename = "DeviceNode", default)]
    pub device_node: Option<String>,
    #[serde(rename = "Size", default)]
    pub size: u64,
    #[serde(rename = "MediaType", default)]
    pub media_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct PhysicalStore {
    #[serde(rename = "APFSPhysicalStore")]
    device_identifier: String,
}

impl DiskInfo {
    fn is_physical_whole_disk(&self) -> bool {
        self.whole_disk
            && matches!(
                self.virtual_or_physical.as_deref(),
                Some("Physical" | "Unknown")
            )
            && self.bus_protocol.as_deref() != Some("Disk Image")
            && self.apfs_physical_stores.is_empty()
            && self.apfs_container_reference.as_deref() != Some(&self.device_identifier)
    }

    pub fn validate_target(&self, system_disks: &HashSet<String>) -> Result<()> {
        if system_disks.contains(&self.device_identifier) {
            return Err(Error::PermissionDenied(format!(
                "{} contains a running macOS system volume and cannot be overwritten",
                self.device_identifier
            )));
        }
        if !self.is_physical_whole_disk() {
            return Err(Error::PermissionDenied(format!(
                "{} is not a physical whole disk and cannot be overwritten",
                self.device_identifier
            )));
        }
        if !(self.removable || self.removable_media || self.ejectable) {
            return Err(Error::PermissionDenied(format!(
                "{} is not a removable drive and cannot be overwritten",
                self.device_identifier
            )));
        }
        Ok(())
    }
}

/// Resolve mounts, APFS snapshots/containers and partitions to physical disks.
/// An incomplete graph is an error: guessing here could expose the boot disk.
pub(super) fn system_disks(
    mounts: &[&str],
    mut info: impl FnMut(&str) -> Result<DiskInfo>,
) -> Result<HashSet<String>> {
    let mut disks = HashSet::new();
    for mount in mounts {
        let mut pending = vec![(mount.to_string(), false)];
        let mut active = HashSet::new();
        let mut resolved = HashSet::new();
        while let Some((device, leaving)) = pending.pop() {
            if leaving {
                active.remove(&device);
                resolved.insert(device);
                continue;
            }
            if resolved.contains(&device) {
                continue;
            }
            if !active.insert(device.clone()) {
                return Err(unresolved_system_disk(mount));
            }
            let disk = info(&device)?;
            pending.push((device, true));
            // Physical-store partitions may also point at their APFS container.
            // Follow their parent first, otherwise we cycle back into it.
            if let Some(parent) = disk
                .parent_whole_disk
                .as_ref()
                .filter(|parent| *parent != &disk.device_identifier)
            {
                pending.push((parent.clone(), false));
            } else if !disk.apfs_physical_stores.is_empty() {
                pending.extend(
                    disk.apfs_physical_stores
                        .into_iter()
                        .map(|store| (store.device_identifier, false)),
                );
            } else if disk.is_physical_whole_disk() {
                // Before the container reference: APFS straight on a whole
                // disk makes the disk its own store, pointing back at the
                // container we came from.
                disks.insert(disk.device_identifier);
            } else if let Some(container) = disk
                .apfs_container_reference
                .as_ref()
                .filter(|container| *container != &disk.device_identifier)
            {
                pending.push((container.clone(), false));
            } else {
                return Err(unresolved_system_disk(mount));
            }
        }
    }
    Ok(disks)
}

fn unresolved_system_disk(mount: &str) -> Error {
    Error::PermissionDenied(format!(
        "Cannot identify the physical disk containing {mount}; refusing to offer flash targets"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(device: &str) -> Result<DiskInfo> {
        let xml = match device {
            "/" => include_str!("fixtures/root-snapshot.plist"),
            "/System/Volumes/Data" => include_str!("fixtures/data-volume.plist"),
            "disk3" => include_str!("fixtures/apfs-container.plist"),
            "disk2s2" => include_str!("fixtures/apfs-store.plist"),
            "disk2" => include_str!("fixtures/usb-disk.plist"),
            "disk4" => include_str!("fixtures/disk-image.plist"),
            _ => return Err(Error::DeviceNotFound(device.into())),
        };
        plist::from_bytes(xml.as_bytes()).map_err(|err| Error::InvalidConfig(err.to_string()))
    }

    /// APFS on a whole disk without a partition map: the disk is its own
    /// physical store, and like any store it points back at its container.
    #[test]
    fn resolves_a_container_on_a_whole_disk_store() {
        let info = |device: &str| -> Result<DiskInfo> {
            let xml = match device {
                "/" => {
                    r#"<plist version="1.0"><dict>
                    <key>DeviceIdentifier</key><string>disk3s1s1</string>
                    <key>ParentWholeDisk</key><string>disk3</string>
                    </dict></plist>"#
                }
                "disk3" => {
                    r#"<plist version="1.0"><dict>
                    <key>DeviceIdentifier</key><string>disk3</string>
                    <key>WholeDisk</key><true/>
                    <key>VirtualOrPhysical</key><string>Virtual</string>
                    <key>APFSContainerReference</key><string>disk3</string>
                    <key>APFSPhysicalStores</key><array>
                    <dict><key>APFSPhysicalStore</key><string>disk2</string></dict>
                    </array>
                    </dict></plist>"#
                }
                "disk2" => {
                    r#"<plist version="1.0"><dict>
                    <key>DeviceIdentifier</key><string>disk2</string>
                    <key>ParentWholeDisk</key><string>disk2</string>
                    <key>WholeDisk</key><true/>
                    <key>VirtualOrPhysical</key><string>Physical</string>
                    <key>BusProtocol</key><string>USB</string>
                    <key>Ejectable</key><true/>
                    <key>APFSContainerReference</key><string>disk3</string>
                    </dict></plist>"#
                }
                _ => return Err(Error::DeviceNotFound(device.into())),
            };
            plist::from_bytes(xml.as_bytes()).map_err(|err| Error::InvalidConfig(err.to_string()))
        };

        let protected = system_disks(&["/"], info).unwrap();
        assert_eq!(protected, HashSet::from(["disk2".into()]));
    }

    #[test]
    fn rejects_external_boot_disk_and_its_apfs_container() {
        let protected = system_disks(&["/", "/System/Volumes/Data"], fixture).unwrap();
        assert_eq!(protected, HashSet::from(["disk2".into()]));
        let error = fixture("disk2")
            .unwrap()
            .validate_target(&protected)
            .unwrap_err();
        assert!(matches!(error, Error::PermissionDenied(_)));
        assert!(error.to_string().contains("running macOS system volume"));
        assert!(fixture("disk3")
            .unwrap()
            .validate_target(&protected)
            .is_err());
    }

    #[test]
    fn only_physical_disk_is_offered_for_non_system_apfs_drive() {
        let protected = HashSet::from(["disk0".into()]);
        assert!(fixture("disk2")
            .unwrap()
            .validate_target(&protected)
            .is_ok());
        for device in ["disk3", "disk2s2", "disk4", "/", "/System/Volumes/Data"] {
            assert!(fixture(device)
                .unwrap()
                .validate_target(&protected)
                .is_err());
        }
    }

    #[test]
    fn disk_image_protocol_alone_is_enough_to_reject_a_target() {
        let mut disk = fixture("disk4").unwrap();
        disk.virtual_or_physical = Some("Unknown".into());
        assert!(disk.validate_target(&HashSet::new()).is_err());
    }

    #[test]
    fn apfs_metadata_alone_is_enough_to_reject_a_container() {
        let mut disk = fixture("disk3").unwrap();
        disk.virtual_or_physical = Some("Unknown".into());
        assert!(disk.validate_target(&HashSet::new()).is_err());
        disk.apfs_physical_stores.clear();
        assert!(disk.validate_target(&HashSet::new()).is_err());
    }

    #[test]
    fn built_in_sd_reader_remains_eligible() {
        let mut disk = fixture("disk2").unwrap();
        disk.ejectable = false;
        disk.removable_media = true;
        disk.bus_protocol = Some("PCI-Express".into());
        disk.virtual_or_physical = Some("Unknown".into());
        assert!(disk.validate_target(&HashSet::new()).is_ok());
        disk.removable_media = false;
        assert!(disk.validate_target(&HashSet::new()).is_err());
    }

    #[test]
    fn missing_safety_metadata_never_makes_a_disk_eligible() {
        let mut disk = fixture("disk2").unwrap();
        disk.virtual_or_physical = None;
        assert!(disk.validate_target(&HashSet::new()).is_err());
        let disk: DiskInfo = plist::from_bytes(
            br#"<?xml version="1.0"?><plist version="1.0"><dict>
                <key>DeviceIdentifier</key><string>disk2</string>
                <key>Ejectable</key><true/>
            </dict></plist>"#,
        )
        .unwrap();
        assert!(disk.validate_target(&HashSet::new()).is_err());
    }

    #[test]
    fn protects_hfs_system_partition_without_apfs_metadata() {
        let protected = system_disks(&["/"], |device| {
            let mut disk = fixture(if device == "/" { "disk2s2" } else { device })?;
            disk.apfs_container_reference = None;
            Ok(disk)
        })
        .unwrap();
        assert_eq!(protected, HashSet::from(["disk2".into()]));
    }

    #[test]
    fn protects_all_physical_stores_of_a_fusion_container() {
        let protected = system_disks(&["/"], |device| {
            let mut disk = fixture(match device {
                "disk5s2" => "disk2s2",
                "disk5" => "disk2",
                _ => device,
            })?;
            match device {
                "disk3" => disk.apfs_physical_stores.push(PhysicalStore {
                    device_identifier: "disk5s2".into(),
                }),
                "disk5s2" => {
                    disk.device_identifier = "disk5s2".into();
                    disk.parent_whole_disk = Some("disk5".into());
                }
                "disk5" => {
                    disk.device_identifier = "disk5".into();
                    disk.parent_whole_disk = Some("disk5".into());
                }
                _ => {}
            }
            Ok(disk)
        })
        .unwrap();
        assert_eq!(protected, HashSet::from(["disk2".into(), "disk5".into()]));
    }

    #[test]
    fn protects_data_volume_even_when_root_is_on_another_disk() {
        let protected = system_disks(&["/", "/System/Volumes/Data"], |device| {
            if device == "/" {
                let mut disk = fixture("disk2")?;
                disk.device_identifier = "disk0".into();
                disk.parent_whole_disk = Some("disk0".into());
                return Ok(disk);
            }
            fixture(device)
        })
        .unwrap();
        assert_eq!(protected, HashSet::from(["disk0".into(), "disk2".into()]));
    }

    #[test]
    fn multiple_stores_on_the_same_physical_disk_are_not_a_cycle() {
        let protected = system_disks(&["/"], |device| {
            let mut disk = fixture(if device == "disk2s3" {
                "disk2s2"
            } else {
                device
            })?;
            if device == "disk3" {
                disk.apfs_physical_stores.push(PhysicalStore {
                    device_identifier: "disk2s3".into(),
                });
            } else if device == "disk2s3" {
                disk.device_identifier = "disk2s3".into();
            }
            Ok(disk)
        })
        .unwrap();
        assert_eq!(protected, HashSet::from(["disk2".into()]));
    }

    #[test]
    fn inspection_failure_or_unresolved_virtual_system_disk_fails_closed() {
        for missing in ["/", "/System/Volumes/Data", "disk3", "disk2s2", "disk2"] {
            assert!(system_disks(&["/", "/System/Volumes/Data"], |device| {
                if device == missing {
                    Err(Error::DeviceNotFound(device.into()))
                } else {
                    fixture(device)
                }
            })
            .is_err());
        }
        assert!(system_disks(&["/"], |_| fixture("disk4")).is_err());
        assert!(system_disks(&["/"], |device| {
            let mut disk = fixture(device)?;
            if device == "disk3" {
                disk.apfs_physical_stores.clear();
            }
            Ok(disk)
        })
        .is_err());
    }

    #[test]
    fn cycles_in_system_disk_metadata_fail_closed() {
        assert!(system_disks(&["/"], |device| {
            let mut disk = fixture(device)?;
            if device == "disk2s2" {
                disk.parent_whole_disk = Some("disk3".into());
            }
            Ok(disk)
        })
        .is_err());
    }
}
