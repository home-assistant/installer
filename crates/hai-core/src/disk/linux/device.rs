//! Linux block device enumeration via `lsblk`.

use super::super::*;
use crate::error::Error;
use serde::Deserialize;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::MetadataExt;
use std::process::Command;

#[derive(Debug, Deserialize)]
struct LsblkOutput {
    blockdevices: Vec<LsblkDevice>,
}

#[derive(Debug, Default, Deserialize)]
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
    pub(super) serial: Option<String>,
    #[serde(default)]
    pub(super) hotplug: Option<bool>,
    // Required in JSON: missing safety information must not mean "safe".
    pub(super) mountpoints: Vec<Option<String>>,
    #[serde(rename = "maj:min")]
    pub(super) device_number: String,
    #[serde(default)]
    pub(super) children: Vec<LsblkDevice>,
    #[serde(skip)]
    in_use: bool,
}

fn read_devices() -> Result<LsblkOutput> {
    // Use lsblk with JSON output for reliable parsing
    let output = Command::new("lsblk")
        .args([
            "-J",     // JSON output
            "-b",     // Size in bytes
            "--tree", // Include partitions and device-mapper/RAID holders
            "-o",     // Output columns
            "NAME,SIZE,TYPE,RM,RO,TRAN,MODEL,VENDOR,SERIAL,HOTPLUG,MOUNTPOINTS,MAJ:MIN",
        ])
        .output()
        .map_err(Error::Io)?;

    if !output.status.success() {
        return Err(Error::DeviceNotFound(format!(
            "lsblk failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    let mut lsblk: LsblkOutput = serde_json::from_slice(&output.stdout)?;
    // Btrfs can span disks without block-layer holders or a mountpoint on
    // every member. Refuse all members of mounted Btrfs filesystems.
    let btrfs = mounted_btrfs_devices(Path::new("/sys/fs/btrfs"))?;
    for number in &btrfs {
        if !mark_in_use(&mut lsblk.blockdevices, number) {
            return Err(Error::DeviceBusy(
                "Cannot identify a mounted Btrfs member".into(),
            ));
        }
    }
    for path in swapfiles(&std::fs::read_to_string("/proc/swaps")?)? {
        let dev = std::fs::metadata(&path)?.dev();
        if !mark_swapfile(
            &mut lsblk.blockdevices,
            dev,
            is_btrfs(&path)?,
            !btrfs.is_empty(),
        ) {
            return Err(Error::DeviceBusy(format!(
                "Cannot identify the disk backing active swap file {}",
                path.display()
            )));
        }
    }
    Ok(lsblk)
}

fn is_btrfs(path: &Path) -> Result<bool> {
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| Error::InvalidConfig("Invalid swap file path".into()))?;
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: path is NUL-terminated and stat points to writable storage.
    if unsafe { libc::statfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: statfs initialized the structure on success.
    Ok(unsafe { stat.assume_init() }.f_type == libc::BTRFS_SUPER_MAGIC)
}

fn mark_swapfile(
    devices: &mut [LsblkDevice],
    dev: u64,
    btrfs: bool,
    btrfs_protected: bool,
) -> bool {
    // Nested Btrfs subvolumes have their own synthetic st_dev, even when
    // they are not separate mounts. Sysfs has already protected every member.
    if btrfs {
        return btrfs_protected;
    }
    mark_in_use(
        devices,
        &format!("{}:{}", libc::major(dev), libc::minor(dev)),
    )
}

fn mounted_btrfs_devices(root: &Path) -> Result<Vec<String>> {
    let filesystems = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut numbers = Vec::new();
    for filesystem in filesystems {
        let filesystem = filesystem?;
        if filesystem.file_name() == "features" {
            continue;
        }
        let devices = std::fs::read_dir(filesystem.path().join("devices"))?;
        for device in devices {
            let number = std::fs::read_to_string(device?.path().join("dev"))?;
            let number = number.trim();
            if !number.split_once(':').is_some_and(|(major, minor)| {
                major.parse::<u32>().is_ok() && minor.parse::<u32>().is_ok()
            }) {
                return Err(Error::InvalidConfig(
                    "Invalid mounted Btrfs device number".into(),
                ));
            }
            numbers.push(number.to_string());
        }
    }
    Ok(numbers)
}

fn swapfiles(contents: &str) -> Result<Vec<std::path::PathBuf>> {
    let invalid = || Error::InvalidConfig("Cannot read active swap information".to_string());
    let mut lines = contents.lines();
    if lines
        .next()
        .map(|line| line.split_whitespace().collect::<Vec<_>>())
        != Some(vec!["Filename", "Type", "Size", "Used", "Priority"])
    {
        return Err(invalid());
    }
    let mut files = Vec::new();
    for line in lines {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() != 5 || !matches!(fields[1], "partition" | "file") {
            return Err(invalid());
        }
        if fields[1] != "file" {
            continue;
        }
        // Linux swap_show escapes space, tab, newline and backslash as octal.
        let mut path = Vec::new();
        let mut bytes = fields[0].bytes();
        while let Some(byte) = bytes.next() {
            if byte == b'\\' {
                let escape = [bytes.next(), bytes.next(), bytes.next()];
                path.push(match escape {
                    [Some(b'0'), Some(b'4'), Some(b'0')] => b' ',
                    [Some(b'0'), Some(b'1'), Some(b'1')] => b'\t',
                    [Some(b'0'), Some(b'1'), Some(b'2')] => b'\n',
                    [Some(b'1'), Some(b'3'), Some(b'4')] => b'\\',
                    _ => return Err(invalid()),
                });
            } else {
                path.push(byte);
            }
        }
        let path = std::path::PathBuf::from(std::ffi::OsString::from_vec(path));
        if !path.is_absolute() {
            return Err(invalid());
        }
        files.push(path);
    }
    Ok(files)
}

fn mark_in_use(devices: &mut [LsblkDevice], number: &str) -> bool {
    let mut found = false;
    for dev in devices {
        if dev.device_number == number {
            dev.in_use = true;
            found = true;
        }
        // Shared holders may appear under more than one physical disk.
        found |= mark_in_use(&mut dev.children, number);
    }
    found
}

fn backs_running_system(dev: &LsblkDevice) -> bool {
    dev.in_use
        || dev.mountpoints.iter().flatten().any(|mount| {
            matches!(mount.as_str(), "/" | "[SWAP]")
                || ["/boot", "/efi", "/usr", "/var", "/home"]
                    .iter()
                    .any(|root| Path::new(mount).starts_with(root))
        })
        || dev.children.iter().any(|child| {
            // A non-partition child is a holder (e.g. LVM, dm-crypt or md).
            child.device_type.as_deref() != Some("part") || backs_running_system(child)
        })
}

pub(super) fn ensure_safe_target(device_id: &str) -> Result<()> {
    check_target(&read_devices()?, device_id)
}

fn check_target(lsblk: &LsblkOutput, device_id: &str) -> Result<()> {
    let dev = lsblk
        .blockdevices
        .iter()
        .find(|dev| {
            dev.device_type.as_deref() == Some("disk") && format!("/dev/{}", dev.name) == device_id
        })
        .ok_or_else(|| Error::DeviceNotFound(device_id.to_string()))?;
    if backs_running_system(dev) {
        return Err(Error::DeviceBusy(format!(
            "{device_id} contains a system mount, active swap, or active storage; refusing to unmount or overwrite it"
        )));
    }
    if dev.ro == Some(true) {
        return Err(Error::WriteProtected);
    }
    Ok(())
}

pub async fn list_devices() -> Result<Vec<BlockDevice>> {
    let lsblk = read_devices()?;

    let mut devices = Vec::new();

    for dev in lsblk.blockdevices {
        // Only include disk devices (not partitions, loop devices, etc.)
        if dev.device_type.as_deref() != Some("disk") {
            continue;
        }

        // Skip read-only devices
        if dev.ro == Some(true) || backs_running_system(&dev) {
            continue;
        }

        let is_removable = dev.rm == Some(true) || dev.hotplug == Some(true);
        let size = dev.size.unwrap_or(0);

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
            serial: normalize_serial(dev.serial.as_deref()),
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

    if mentions_sd_card(&model) {
        return DeviceType::SdCard;
    }

    // Check transport type
    match transport {
        "usb" => DeviceType::UsbDrive,
        "nvme" => DeviceType::Nvme,
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
    use super::*;
    use crate::types::DeviceType;

    fn disk(child: serde_json::Value) -> LsblkOutput {
        serde_json::from_value(serde_json::json!({"blockdevices": [{
            "name": "sdb", "type": "disk", "hotplug": true, "rm": true,
            "mountpoints": [null], "maj:min": "8:16", "children": [child]
        }]}))
        .unwrap()
    }

    fn partition(mountpoints: serde_json::Value) -> serde_json::Value {
        serde_json::json!({"name": "sdb1", "type": "part", "maj:min": "8:17", "mountpoints": mountpoints})
    }

    #[test]
    fn rejects_system_mounts_even_on_removable_hotplug_disks() {
        for mount in [
            "/",
            "/boot",
            "/boot/efi",
            "/efi",
            "/efi/EFI",
            "/usr",
            "/var",
            "/var/lib",
            "/home",
            "/home/user",
            "[SWAP]",
        ] {
            let tree = disk(partition(serde_json::json!(["/media/alias", mount])));
            assert!(
                matches!(check_target(&tree, "/dev/sdb"), Err(Error::DeviceBusy(_))),
                "{mount}"
            );
        }
    }

    #[test]
    fn rejects_holders_even_when_unmounted() {
        for kind in ["lvm", "crypt", "dm", "raid1", "mpath"] {
            let mut part = partition(serde_json::json!([null]));
            part["children"] = serde_json::json!([{
                "name": "holder", "type": kind, "maj:min": "253:0", "mountpoints": [null]
            }]);
            assert!(matches!(
                check_target(&disk(part), "/dev/sdb"),
                Err(Error::DeviceBusy(_))
            ));
        }
    }

    #[test]
    fn permits_ordinary_media_but_rejects_missing_or_read_only_targets() {
        for mounts in [
            serde_json::json!([null]),
            serde_json::json!([]),
            serde_json::json!([
                "/media/card",
                "/mnt/card",
                "/homework",
                "/various",
                "/efibackup"
            ]),
        ] {
            let mut tree = disk(partition(mounts));
            assert!(check_target(&tree, "/dev/sdb").is_ok());
            assert!(matches!(
                check_target(&tree, "/dev/sdb1"),
                Err(Error::DeviceNotFound(_))
            ));
            assert!(matches!(
                check_target(&tree, "/dev/sdc"),
                Err(Error::DeviceNotFound(_))
            ));
            tree.blockdevices[0].ro = Some(true);
            assert!(matches!(
                check_target(&tree, "/dev/sdb"),
                Err(Error::WriteProtected)
            ));
        }
    }

    #[test]
    fn whole_disk_filesystem_is_checked() {
        let mut tree = disk(partition(serde_json::json!([null])));
        tree.blockdevices[0].children.clear();
        tree.blockdevices[0].mountpoints = vec![Some("/".to_string())];
        assert!(check_target(&tree, "/dev/sdb").is_err());
    }

    #[test]
    fn missing_safety_columns_fail_closed() {
        for missing in ["mountpoints", "maj:min"] {
            let mut value = partition(serde_json::json!([null]));
            value.as_object_mut().unwrap().remove(missing);
            assert!(serde_json::from_value::<LsblkDevice>(value).is_err());
        }
    }

    #[test]
    fn swapfiles_protect_all_backing_disks() {
        let mut tree = disk(partition(serde_json::json!(["/mnt/data"])));
        assert!(!mark_swapfile(
            &mut tree.blockdevices,
            libc::makedev(8, 99),
            false,
            false
        ));
        assert!(mark_swapfile(
            &mut tree.blockdevices,
            libc::makedev(8, 17),
            false,
            false
        ));
        assert!(matches!(
            check_target(&tree, "/dev/sdb"),
            Err(Error::DeviceBusy(_))
        ));
    }

    #[test]
    fn swapfile_in_btrfs_subvolume_uses_protected_members() {
        let mut tree = disk(partition(serde_json::json!(["/mnt/data"])));
        assert!(!mark_swapfile(
            &mut tree.blockdevices,
            libc::makedev(0, 42),
            true,
            false
        ));
        mark_in_use(&mut tree.blockdevices, "8:17");
        assert!(mark_swapfile(
            &mut tree.blockdevices,
            libc::makedev(0, 42),
            true,
            true
        ));
        assert!(!mark_swapfile(
            &mut tree.blockdevices,
            libc::makedev(0, 42),
            false,
            true
        ));
        assert!(matches!(
            check_target(&tree, "/dev/sdb"),
            Err(Error::DeviceBusy(_))
        ));
    }

    #[test]
    fn mounted_btrfs_protects_members_without_mountpoints() {
        let sysfs = tempfile::tempdir().unwrap();
        std::fs::create_dir(sysfs.path().join("features")).unwrap();
        for (name, number) in [("sdb1", "8:17\n"), ("sdc1", "8:33\n")] {
            let path = sysfs.path().join("uuid/devices").join(name);
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(path.join("dev"), number).unwrap();
        }
        let mut tree = disk(partition(serde_json::json!(["/"])));
        tree.blockdevices.push(serde_json::from_value(serde_json::json!({
            "name": "sdc", "type": "disk", "hotplug": true, "maj:min": "8:32", "mountpoints": [null],
            "children": [{"name": "sdc1", "type": "part", "maj:min": "8:33", "mountpoints": [null]}]
        })).unwrap());
        for number in mounted_btrfs_devices(sysfs.path()).unwrap() {
            mark_in_use(&mut tree.blockdevices, &number);
        }
        assert!(check_target(&tree, "/dev/sdb").is_err());
        assert!(check_target(&tree, "/dev/sdc").is_err());
        assert!(mounted_btrfs_devices(&sysfs.path().join("missing"))
            .unwrap()
            .is_empty());
        std::fs::write(sysfs.path().join("uuid/devices/sdc1/dev"), "invalid").unwrap();
        assert!(mounted_btrfs_devices(sysfs.path()).is_err());
        std::fs::remove_file(sysfs.path().join("uuid/devices/sdc1/dev")).unwrap();
        assert!(mounted_btrfs_devices(sysfs.path()).is_err());
        let incomplete = tempfile::tempdir().unwrap();
        std::fs::create_dir(incomplete.path().join("uuid")).unwrap();
        assert!(mounted_btrfs_devices(incomplete.path()).is_err());
    }

    #[test]
    fn parses_swapfiles_with_kernel_path_escapes() {
        let header = "Filename\tType\tSize\tUsed\tPriority\n";
        assert!(swapfiles(header).unwrap().is_empty());
        let contents = format!("{header}/dev/sda1 partition 1024 0 -1\n/mnt/swap\\040file\\134x\\011y\\012z file 1024 0 -2\n");
        assert_eq!(
            swapfiles(&contents).unwrap(),
            vec![std::path::PathBuf::from("/mnt/swap file\\x\ty\nz")]
        );
        for row in [
            "bad",
            "/swap unknown 1 0 -1",
            "swap file 1 0 -1",
            "/swap\\040 file",
            "/swap\\999 file 1 0 -1",
        ] {
            assert!(swapfiles(&format!("{header}{row}\n")).is_err(), "{row}");
        }
        assert!(swapfiles("").is_err());
    }

    #[test]
    fn reads_optional_lsblk_serial() {
        for (serial, expected) in [
            ("null", None),
            ("\"  \"", None),
            ("\" ABC123 \"", Some("ABC123")),
        ] {
            let dev: LsblkDevice = serde_json::from_str(&format!(
                r#"{{"name":"sdb","mountpoints":[],"maj:min":"8:16","serial":{serial}}}"#
            ))
            .unwrap();
            assert_eq!(
                crate::disk::normalize_serial(dev.serial.as_deref()).as_deref(),
                expected
            );
        }
        let dev: LsblkDevice =
            serde_json::from_str(r#"{"name":"sdb","mountpoints":[],"maj:min":"8:16"}"#).unwrap();
        assert_eq!(dev.serial, None);
    }

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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
        };
        assert_eq!(determine_device_type(&dev), DeviceType::Nvme);
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
        };
        assert_eq!(determine_device_type(&dev), DeviceType::SdCard);
    }

    #[test]
    fn test_determine_device_type_portable_ssd_is_not_sd_card() {
        // "SSD" contains "sd" as a substring; only whole-word "SD" counts.
        let dev = LsblkDevice {
            name: "sdb".to_string(),
            size: Some(500_000_000_000),
            device_type: Some("disk".to_string()),
            rm: Some(false),
            ro: Some(false),
            tran: Some("usb".to_string()),
            model: Some("Portable SSD T7".to_string()),
            vendor: Some("Samsung".to_string()),
            hotplug: Some(true),
            ..Default::default()
        };
        assert_eq!(determine_device_type(&dev), DeviceType::UsbDrive);
    }

    #[test]
    fn test_determine_device_type_microsd_reader_is_sd_card() {
        let dev = LsblkDevice {
            name: "sdb".to_string(),
            size: Some(32_000_000_000),
            device_type: Some("disk".to_string()),
            rm: Some(true),
            ro: Some(false),
            tran: Some("usb".to_string()),
            model: Some("microSD".to_string()),
            vendor: None,
            hotplug: Some(true),
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
