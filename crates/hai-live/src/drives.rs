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

/// A whole disk that could be an install target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Disk {
    /// Kernel name, for example `sda` or `nvme0n1`.
    pub name: String,
    /// Disk type.
    pub kind: Kind,
    /// Vendor and model as reported by the kernel.
    pub model: String,
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
        reason: &'static str,
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
            reason: "connection type unknown",
        };
    };
    if is_usb_path(&link.to_string_lossy()) {
        return Entry::Skipped {
            name,
            reason: "USB device",
        };
    }
    // mmcblk is used for both soldered eMMC and SD cards; only eMMC reports "MMC".
    if kind == Kind::Emmc {
        let reason = match read_trimmed(&dir.join("device").join("type")).as_deref() {
            Some("MMC") => None,
            Some("SD") => Some("SD card"),
            _ => Some("card type unknown"),
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
            reason: "no media",
        };
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
fn classify(name: &str) -> Result<Kind, &'static str> {
    let rest_is_digits = |prefix: &str| {
        name.strip_prefix(prefix)
            .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|c| c.is_ascii_digit()))
    };
    if name.starts_with("loop") {
        Err("loop device")
    } else if name.starts_with("ram") || name.starts_with("zram") {
        Err("RAM disk")
    } else if name.starts_with("sr") {
        Err("optical drive")
    } else if name.starts_with("mmcblk") && (name.contains("boot") || name.contains("rpmb")) {
        Err("eMMC boot area")
    } else if rest_is_digits("mmcblk") {
        Ok(Kind::Emmc)
    } else if is_nvme_namespace(name) {
        Ok(Kind::Nvme)
    } else if name.starts_with("sd") && name[2..].bytes().all(|c| c.is_ascii_lowercase()) {
        Ok(Kind::Sata)
    } else if name.starts_with("vd") && name[2..].bytes().all(|c| c.is_ascii_lowercase()) {
        Ok(Kind::Virtio)
    } else {
        Err("not a supported disk type")
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

fn model(dir: &Path, kind: Kind) -> String {
    let device = dir.join("device");
    let parts: Vec<String> = match kind {
        Kind::Sata => ["vendor", "model"]
            .iter()
            .filter_map(|f| read_trimmed(&device.join(f)))
            .collect(),
        Kind::Nvme => read_trimmed(&device.join("model")).into_iter().collect(),
        Kind::Emmc => read_trimmed(&device.join("name")).into_iter().collect(),
        Kind::Virtio => vec!["VirtIO disk".to_string()],
    };
    let model = parts.join(" ");
    if model.is_empty() {
        "unknown model".to_string()
    } else {
        model
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

fn read_trimmed(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Adds `/sys/block/<name>` with a size in bytes and optional device files.
    pub(crate) fn add_block(sys: &Path, name: &str, bytes: u64, device: &[(&str, &str)]) {
        let dir = sys.join(name);
        fs::create_dir_all(dir.join("device")).unwrap();
        fs::write(dir.join("size"), format!("{}\n", bytes / 512)).unwrap();
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
                model: "ATA Samsung SSD 870".into(),
                size_bytes: 34_359_738_368,
                serial: Some("t10.ATA Samsung SSD 870 S5Y1NX0R".into()),
            })
        );
        assert!(matches!(&entries[1], Entry::Disk(d)
            if d.model == "WD Blue SN570" && d.serial.as_deref() == Some("22123K801234")));
        assert!(matches!(
            entries[0],
            Entry::Skipped {
                reason: "loop device",
                ..
            }
        ));
        assert!(matches!(
            entries[3],
            Entry::Skipped {
                reason: "no media",
                ..
            }
        ));
        assert!(matches!(
            entries[4],
            Entry::Skipped {
                reason: "optical drive",
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
                reason: "SD card",
                ..
            }
        ));
        assert!(matches!(
            entries[2],
            Entry::Skipped {
                reason: "card type unknown",
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
                reason: "USB device",
                ..
            }
        ));
        assert!(matches!(
            entries[1],
            Entry::Skipped {
                reason: "connection type unknown",
                ..
            }
        ));
    }

    #[test]
    fn finds_partitions() {
        let dir = tempfile::tempdir().unwrap();
        add_block(dir.path(), "sda", 1 << 30, &[]);
        add_partition(dir.path(), "sda", "sda2");
        add_partition(dir.path(), "sda", "sda1");
        fs::create_dir(dir.path().join("sda").join("queue")).unwrap();
        assert_eq!(partitions(dir.path(), "sda").unwrap(), ["sda1", "sda2"]);
        assert!(partitions(dir.path(), "sdb").is_err());
    }
}
