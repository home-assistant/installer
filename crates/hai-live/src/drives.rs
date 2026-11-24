//! Lists block devices from sysfs (`/sys/block`).
//!
//! Only plain file reads, so the logic is testable on any OS against a fake sysfs folder.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Disk types we offer as install targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// SATA or SCSI disk (`sd*`).
    Sata,
    /// NVMe namespace (`nvme*n*`).
    Nvme,
    /// eMMC (`mmcblk*`).
    Emmc,
    /// VirtIO block disk (`vd*`), only seen in VMs.
    Virtio,
}

impl Kind {
    /// Short name for the screen.
    pub fn label(self) -> &'static str {
        match self {
            Kind::Sata => "SATA",
            Kind::Nvme => "NVMe",
            Kind::Emmc => "eMMC",
            Kind::Virtio => "VirtIO",
        }
    }
}

/// What a disk is, as far as the kernel says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Model {
    /// Vendor and model as reported by the kernel.
    Reported(String),
    /// A VirtIO disk, which reports no model.
    Virtio,
    /// The kernel reports none.
    Unknown,
}

/// Why a device is never offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Reason {
    LoopDevice,
    RamDisk,
    OpticalDrive,
    EmmcBootArea,
    UnsupportedType,
    /// Its place in the hardware tree can't be read, so it may be on USB.
    ConnectionUnknown,
    UsbDevice,
    SdCard,
    /// An `mmcblk` that says neither eMMC nor SD card.
    CardTypeUnknown,
    NoMedia,
    /// Logical sectors other than 512 bytes.
    LargeSectors,
    SectorSizeUnknown,
}

impl Reason {
    /// The message that says it.
    pub fn key(self) -> &'static str {
        match self {
            Reason::LoopDevice => "live.drives.hidden.loop_device",
            Reason::RamDisk => "live.drives.hidden.ram_disk",
            Reason::OpticalDrive => "live.drives.hidden.optical_drive",
            Reason::EmmcBootArea => "live.drives.hidden.emmc_boot_area",
            Reason::UnsupportedType => "live.drives.hidden.unsupported_type",
            Reason::ConnectionUnknown => "live.drives.hidden.connection_unknown",
            Reason::UsbDevice => "live.drives.hidden.usb_device",
            Reason::SdCard => "live.drives.hidden.sd_card",
            Reason::CardTypeUnknown => "live.drives.hidden.card_type_unknown",
            Reason::NoMedia => "live.drives.hidden.no_media",
            Reason::LargeSectors => "live.drives.hidden.large_sectors",
            Reason::SectorSizeUnknown => "live.drives.hidden.sector_size_unknown",
        }
    }
}

/// A whole disk that could be an install target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Disk {
    /// Kernel name, for example `sda` or `nvme0n1`.
    pub name: String,
    /// Disk type.
    pub kind: Kind,
    /// Vendor and model.
    pub model: Model,
    /// Size in bytes.
    pub size_bytes: u64,
    /// Hardware serial, if the kernel reports one. Part of the identity re-checked before writing.
    pub serial: Option<String>,
}

/// One entry of `/sys/block`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    /// A whole disk of a supported type.
    Disk(Disk),
    /// Anything we never offer, with the reason.
    Skipped {
        /// Kernel name.
        name: String,
        /// Why it isn't offered.
        reason: Reason,
    },
}

/// Lists every entry of `sys_block` (normally `/sys/block`), sorted by name.
pub fn list(sys_block: &Path) -> io::Result<Vec<Entry>> {
    list_with(sys_block, &|path| fs::read_link(path))
}

/// Like [`list`], with the symlink reader passed in so tests can fake the hardware tree.
pub(crate) fn list_with(
    sys_block: &Path,
    read_link: &dyn Fn(&Path) -> io::Result<PathBuf>,
) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for item in fs::read_dir(sys_block)? {
        let name = item?.file_name().to_string_lossy().into_owned();
        entries.push(entry(sys_block, name, read_link));
    }
    entries.sort_by(|a, b| entry_name(a).cmp(entry_name(b)));
    Ok(entries)
}

fn entry_name(entry: &Entry) -> &str {
    match entry {
        Entry::Disk(disk) => &disk.name,
        Entry::Skipped { name, .. } => name,
    }
}

fn entry(
    sys_block: &Path,
    name: String,
    read_link: &dyn Fn(&Path) -> io::Result<PathBuf>,
) -> Entry {
    let kind = match classify(&name) {
        Ok(kind) => kind,
        Err(reason) => return Entry::Skipped { name, reason },
    };
    let dir = sys_block.join(&name);
    // /sys/block/<name> links to the device's place in the hardware tree. If that can't be
    // read we can't rule out USB, so the device is never offered.
    let Ok(link) = read_link(&dir) else {
        return Entry::Skipped {
            name,
            reason: Reason::ConnectionUnknown,
        };
    };
    if is_usb_path(&link.to_string_lossy()) {
        return Entry::Skipped {
            name,
            reason: Reason::UsbDevice,
        };
    }
    // mmcblk is used for both soldered eMMC and SD cards; only eMMC reports "MMC".
    if kind == Kind::Emmc {
        let reason = match read_trimmed(&dir.join("device").join("type")).as_deref() {
            Some("MMC") => None,
            Some("SD") => Some(Reason::SdCard),
            _ => Some(Reason::CardTypeUnknown),
        };
        if let Some(reason) = reason {
            return Entry::Skipped { name, reason };
        }
    }
    let size_bytes = read_trimmed(&dir.join("size"))
        .and_then(|s| s.parse::<u64>().ok())
        .and_then(|sectors| sectors.checked_mul(512)) // sysfs always counts 512-byte sectors
        .unwrap_or(0);
    if size_bytes == 0 {
        return Entry::Skipped {
            name,
            reason: Reason::NoMedia,
        };
    }
    // The Home Assistant OS image has a partition table for 512-byte sectors, written as is.
    // On a disk with larger logical sectors it lands in the wrong place and nothing boots.
    let sector_size = read_trimmed(&dir.join("queue").join("logical_block_size"))
        .and_then(|s| s.parse::<u64>().ok());
    match sector_size {
        Some(512) => {}
        Some(_) => {
            return Entry::Skipped {
                name,
                reason: Reason::LargeSectors,
            };
        }
        None => {
            return Entry::Skipped {
                name,
                reason: Reason::SectorSizeUnknown,
            };
        }
    }
    Entry::Disk(Disk {
        model: model(&dir, kind),
        serial: serial(&dir),
        name,
        kind,
        size_bytes,
    })
}

/// Maps a kernel name to a supported disk type, or the reason it's never offered.
fn classify(name: &str) -> Result<Kind, Reason> {
    let rest_is_digits = |prefix: &str| {
        name.strip_prefix(prefix)
            .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|c| c.is_ascii_digit()))
    };
    if name.starts_with("loop") {
        Err(Reason::LoopDevice)
    } else if name.starts_with("ram") || name.starts_with("zram") {
        Err(Reason::RamDisk)
    } else if name.starts_with("sr") {
        Err(Reason::OpticalDrive)
    } else if name.starts_with("mmcblk") && (name.contains("boot") || name.contains("rpmb")) {
        Err(Reason::EmmcBootArea)
    } else if rest_is_digits("mmcblk") {
        Ok(Kind::Emmc)
    } else if is_nvme_namespace(name) {
        Ok(Kind::Nvme)
    } else if name.starts_with("sd") && name[2..].bytes().all(|c| c.is_ascii_lowercase()) {
        Ok(Kind::Sata)
    } else if name.starts_with("vd") && name[2..].bytes().all(|c| c.is_ascii_lowercase()) {
        Ok(Kind::Virtio)
    } else {
        Err(Reason::UnsupportedType)
    }
}

/// `nvme<controller>n<namespace>`, for example `nvme0n1` (partitions add `p<n>`).
fn is_nvme_namespace(name: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    name.strip_prefix("nvme")
        .and_then(|rest| rest.split_once('n'))
        .is_some_and(|(controller, namespace)| digits(controller) && digits(namespace))
}

fn is_usb_path(sys_path: &str) -> bool {
    sys_path.split('/').any(|part| part.starts_with("usb"))
}

fn model(dir: &Path, kind: Kind) -> Model {
    let device = dir.join("device");
    let parts: Vec<String> = match kind {
        Kind::Sata => ["vendor", "model"]
            .iter()
            .filter_map(|f| read_trimmed(&device.join(f)))
            .collect(),
        Kind::Nvme => read_trimmed(&device.join("model")).into_iter().collect(),
        Kind::Emmc => read_trimmed(&device.join("name")).into_iter().collect(),
        Kind::Virtio => return Model::Virtio,
    };
    if parts.is_empty() {
        Model::Unknown
    } else {
        Model::Reported(parts.join(" "))
    }
}

/// NVMe and eMMC report `device/serial`; SATA/SCSI disks usually only `device/wwid`, which embeds it.
fn serial(dir: &Path) -> Option<String> {
    let device = dir.join("device");
    read_trimmed(&device.join("serial")).or_else(|| read_trimmed(&device.join("wwid")))
}

/// Partition names of `disk`: subfolders that contain a `partition` file.
/// Any read error is returned, so callers can't mistake a partial list for a complete one.
pub fn partitions(sys_block: &Path, disk: &str) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    for item in fs::read_dir(sys_block.join(disk))? {
        let item = item?;
        // Partitions are real folders; skip files and symlinks such as `size` and `device`.
        if !item.file_type()?.is_dir() {
            continue;
        }
        match fs::metadata(item.path().join("partition")) {
            Ok(_) => names.push(item.file_name().to_string_lossy().into_owned()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    names.sort();
    Ok(names)
}

/// The disk that holds `file`: the disk itself, or the disk one of whose partitions it's on.
/// `None` when the file isn't on a disk in `sys_block`, for example when it was copied to RAM.
#[cfg(unix)]
pub fn disk_holding(sys_block: &Path, file: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let number = device_number(fs::metadata(file).ok()?.dev());
    disk_with_device(sys_block, &number)
}

/// hai-live only runs on Linux; elsewhere no file is ever on a disk.
#[cfg(not(unix))]
pub fn disk_holding(_sys_block: &Path, _file: &Path) -> Option<String> {
    None
}

/// Linux encodes major and minor in a `dev_t` like this (see `gnu_dev_major` in glibc).
#[cfg(any(unix, test))]
fn device_number(dev: u64) -> String {
    let major = ((dev >> 8) & 0xfff) | ((dev >> 32) & !0xfff);
    let minor = (dev & 0xff) | ((dev >> 12) & !0xff);
    format!("{major}:{minor}")
}

/// The disk in `sys_block` whose `dev` file, or one of whose partitions' `dev` file, is `number`.
#[cfg(any(unix, test))]
fn disk_with_device(sys_block: &Path, number: &str) -> Option<String> {
    let is_number = |dir: &Path| read_trimmed(&dir.join("dev")).as_deref() == Some(number);
    for item in fs::read_dir(sys_block).ok()?.flatten() {
        let disk = item.file_name().to_string_lossy().into_owned();
        let dir = sys_block.join(&disk);
        let on_a_partition = partitions(sys_block, &disk)
            .unwrap_or_default()
            .iter()
            .any(|part| is_number(&dir.join(part)));
        if is_number(&dir) || on_a_partition {
            return Some(disk);
        }
    }
    None
}

fn read_trimmed(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Adds `/sys/block/<name>` with a size in bytes, 512-byte sectors and optional device files.
    pub(crate) fn add_block(sys: &Path, name: &str, bytes: u64, device: &[(&str, &str)]) {
        let dir = sys.join(name);
        fs::create_dir_all(dir.join("device")).unwrap();
        fs::create_dir_all(dir.join("queue")).unwrap();
        fs::write(dir.join("size"), format!("{}\n", bytes / 512)).unwrap();
        fs::write(dir.join("queue").join("logical_block_size"), "512\n").unwrap();
        for (file, text) in device {
            fs::write(dir.join("device").join(file), format!("{text}\n")).unwrap();
        }
    }

    pub(crate) fn add_partition(sys: &Path, disk: &str, part: &str) {
        let dir = sys.join(disk).join(part);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("partition"), "1\n").unwrap();
    }

    /// Fake `/sys/block` symlinks: disks named `sdu*` are on USB, everything else on SATA.
    pub(crate) fn fake_link(path: &Path) -> io::Result<PathBuf> {
        let name = path.file_name().unwrap().to_string_lossy();
        let bus = if name.starts_with("sdu") {
            "usb1/1-2"
        } else {
            "ata1"
        };
        Ok(PathBuf::from(format!(
            "../devices/pci0000:00/{bus}/host0/block/{name}"
        )))
    }

    #[test]
    fn decodes_device_numbers_like_the_kernel() {
        assert_eq!(device_number(0x0811), "8:17");
        assert_eq!(device_number(0xfd00), "253:0");
        // NVMe and other large numbers use the high bits
        assert_eq!(device_number((259 << 8) | 3), "259:3");
        assert_eq!(
            device_number((8 << 8) | (300 & 0xff) | ((300 & !0xff) << 12)),
            "8:300"
        );
    }

    #[test]
    fn finds_the_disk_holding_a_device() {
        let dir = tempfile::tempdir().unwrap();
        let sys = dir.path();
        add_block(sys, "sda", 1_000_000_000, &[]);
        fs::write(sys.join("sda").join("dev"), "8:0\n").unwrap();
        add_partition(sys, "sda", "sda1");
        fs::write(sys.join("sda").join("sda1").join("dev"), "8:1\n").unwrap();
        add_block(sys, "vda", 1_000_000_000, &[]);
        fs::write(sys.join("vda").join("dev"), "254:0\n").unwrap();

        assert_eq!(disk_with_device(sys, "8:1").as_deref(), Some("sda"));
        assert_eq!(disk_with_device(sys, "254:0").as_deref(), Some("vda"));
        assert_eq!(disk_with_device(sys, "0:42"), None);
    }

    #[test]
    fn classifies_kernel_names() {
        for (name, kind) in [
            ("sda", Kind::Sata),
            ("sdab", Kind::Sata),
            ("nvme0n1", Kind::Nvme),
            ("mmcblk0", Kind::Emmc),
            ("vda", Kind::Virtio),
        ] {
            assert_eq!(classify(name), Ok(kind), "{name}");
        }
        for name in [
            "loop0",
            "ram15",
            "zram0",
            "sr0",
            "mmcblk0boot0",
            "mmcblk0rpmb",
            "nvme0n1p1",
            "sda1",
            "dm-0",
            "md0",
            "nbd0",
        ] {
            assert!(classify(name).is_err(), "{name}");
        }
    }

    #[test]
    fn detects_usb_paths() {
        assert!(is_usb_path(
            "../devices/pci0000:00/0000:00:14.0/usb1/1-2/1-2:1.0/host6/target6:0:0/6:0:0:0/block/sdb"
        ));
        assert!(!is_usb_path(
            "../devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sda"
        ));
    }

    #[test]
    fn lists_disks_with_model_and_size_and_skips_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let sys = dir.path();
        add_block(
            sys,
            "sda",
            34_359_738_368,
            &[
                ("vendor", "ATA"),
                ("model", "Samsung SSD 870"),
                ("wwid", "t10.ATA Samsung SSD 870 S5Y1NX0R"),
            ],
        );
        add_block(
            sys,
            "nvme0n1",
            256_060_514_304,
            &[("model", "WD Blue SN570"), ("serial", "22123K801234")],
        );
        add_block(sys, "loop0", 307_429_376, &[]);
        add_block(sys, "sr0", 0, &[]);
        add_block(sys, "sdb", 0, &[("model", "Card Reader")]);

        let entries = list_with(sys, &fake_link).unwrap();
        let names: Vec<&str> = entries.iter().map(entry_name).collect();
        assert_eq!(names, ["loop0", "nvme0n1", "sda", "sdb", "sr0"]);

        assert_eq!(
            entries[2],
            Entry::Disk(Disk {
                name: "sda".into(),
                kind: Kind::Sata,
                model: Model::Reported("ATA Samsung SSD 870".into()),
                size_bytes: 34_359_738_368,
                serial: Some("t10.ATA Samsung SSD 870 S5Y1NX0R".into()),
            })
        );
        assert!(matches!(&entries[1], Entry::Disk(d)
            if d.model == Model::Reported("WD Blue SN570".into())
                && d.serial.as_deref() == Some("22123K801234")));
        assert!(matches!(
            entries[0],
            Entry::Skipped {
                reason: Reason::LoopDevice,
                ..
            }
        ));
        assert!(matches!(
            entries[3],
            Entry::Skipped {
                reason: Reason::NoMedia,
                ..
            }
        ));
        assert!(matches!(
            entries[4],
            Entry::Skipped {
                reason: Reason::OpticalDrive,
                ..
            }
        ));
    }

    #[test]
    fn offers_emmc_but_hides_sd_cards() {
        let dir = tempfile::tempdir().unwrap();
        add_block(dir.path(), "mmcblk0", 64_000_000_000, &[("type", "MMC")]);
        add_block(dir.path(), "mmcblk1", 64_000_000_000, &[("type", "SD")]);
        add_block(dir.path(), "mmcblk2", 64_000_000_000, &[]);

        let entries = list_with(dir.path(), &fake_link).unwrap();
        assert!(matches!(&entries[0], Entry::Disk(d) if d.kind == Kind::Emmc));
        assert!(matches!(
            entries[1],
            Entry::Skipped {
                reason: Reason::SdCard,
                ..
            }
        ));
        assert!(matches!(
            entries[2],
            Entry::Skipped {
                reason: Reason::CardTypeUnknown,
                ..
            }
        ));
    }

    #[test]
    fn hides_usb_disks_and_disks_whose_bus_is_unknown() {
        let dir = tempfile::tempdir().unwrap();
        add_block(dir.path(), "sdu", 64_000_000_000, &[]);
        add_block(dir.path(), "sdz", 64_000_000_000, &[]);
        let unreadable = |path: &Path| {
            if path.ends_with("sdz") {
                Err(io::Error::from(io::ErrorKind::NotFound))
            } else {
                fake_link(path)
            }
        };

        let entries = list_with(dir.path(), &unreadable).unwrap();
        assert!(matches!(
            entries[0],
            Entry::Skipped {
                reason: Reason::UsbDevice,
                ..
            }
        ));
        assert!(matches!(
            entries[1],
            Entry::Skipped {
                reason: Reason::ConnectionUnknown,
                ..
            }
        ));
    }

    #[test]
    fn offers_only_disks_with_512_byte_sectors() {
        let dir = tempfile::tempdir().unwrap();
        let sys = dir.path();
        for name in ["sda", "sdb", "sdc", "sdd"] {
            add_block(sys, name, 64_000_000_000, &[]);
        }
        let sector_size = |name: &str| sys.join(name).join("queue").join("logical_block_size");
        fs::write(sector_size("sdb"), "4096\n").unwrap();
        fs::remove_file(sector_size("sdc")).unwrap();
        fs::write(sector_size("sdd"), "not a number\n").unwrap();

        let entries = list_with(sys, &fake_link).unwrap();
        assert!(matches!(&entries[0], Entry::Disk(d) if d.name == "sda"));
        for (entry, expected) in entries[1..].iter().zip([
            Reason::LargeSectors,
            Reason::SectorSizeUnknown,
            Reason::SectorSizeUnknown,
        ]) {
            assert!(
                matches!(entry, Entry::Skipped { reason, .. } if *reason == expected),
                "{entry:?}"
            );
        }
    }

    #[test]
    fn finds_partitions() {
        let dir = tempfile::tempdir().unwrap();
        add_block(dir.path(), "sda", 1 << 30, &[]);
        add_partition(dir.path(), "sda", "sda2");
        add_partition(dir.path(), "sda", "sda1");
        assert_eq!(partitions(dir.path(), "sda").unwrap(), ["sda1", "sda2"]);
        assert!(partitions(dir.path(), "sdb").is_err());
    }
}
