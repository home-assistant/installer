//! Safety rules for install targets: never offer the HAI stick, and refuse disks that are too small.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use crate::drives::{self, Disk, Entry};

/// FAT volume label `hai-usb` gives the stick (must match `hai-usb`'s `VOLUME_LABEL`).
const STICK_LABEL: &[u8; 11] = b"HAI-LIVE   ";

/// HAOS needs a 32 GB disk. Same 5% allowance as hai-core, because "32 GB" disks report a bit less.
pub const MIN_SIZE_BYTES: u64 = 32_000_000_000 - 32_000_000_000 / 20;

/// A disk shown to the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    /// The disk.
    pub disk: Disk,
    /// Why it can't be used, if it can't.
    pub problem: Option<&'static str>,
}

/// Disks to show, and everything else with the reason it's hidden.
#[derive(Debug, Default)]
pub struct Review {
    /// Disks shown to the user, usable or not.
    pub choices: Vec<Choice>,
    /// Hidden devices: (name, reason).
    pub hidden: Vec<(String, &'static str)>,
}

/// Applies the rules to `entries`. `sys_block` is `/sys/block`, `dev` is `/dev`.
pub fn review(entries: Vec<Entry>, sys_block: &Path, dev: &Path) -> Review {
    let mut review = Review::default();
    for entry in entries {
        match entry {
            Entry::Skipped { name, reason } => review.hidden.push((name, reason)),
            Entry::Disk(disk) => match is_hai_stick(sys_block, dev, &disk.name) {
                Ok(true) => review.hidden.push((disk.name, "HAI live stick")),
                // Can't rule out that this is the stick we booted from, so never offer it.
                Err(_) => review
                    .hidden
                    .push((disk.name, "partitions can't be checked")),
                Ok(false) => {
                    let problem =
                        (disk.size_bytes < MIN_SIZE_BYTES).then_some("smaller than 32 GB");
                    review.choices.push(Choice { disk, problem });
                }
            },
        }
    }
    review
}

/// Re-checks right before writing that `disk` is still in `current` (a fresh [`drives::list`]),
/// unchanged (name, model, size and serial) and usable.
pub fn still_usable(disk: &Disk, current: Vec<Entry>, sys_block: &Path, dev: &Path) -> bool {
    review(current, sys_block, dev)
        .choices
        .iter()
        .any(|c| c.problem.is_none() && c.disk == *disk)
}

/// Whether any partition of `disk` carries the HAI stick's FAT label. Errors if any can't be read.
fn is_hai_stick(sys_block: &Path, dev: &Path, disk: &str) -> io::Result<bool> {
    for part in drives::partitions(sys_block, disk)? {
        let mut sector = [0u8; 512];
        File::open(dev.join(&part))?.read_exact(&mut sector)?;
        if has_hai_label(&sector) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// FAT32 boot sector: label at 0x47, filesystem type at 0x52.
fn has_hai_label(sector: &[u8; 512]) -> bool {
    &sector[0x52..0x5a] == b"FAT32   " && &sector[0x47..0x52] == STICK_LABEL
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drives::tests::{add_block, add_partition, fake_link};

    fn fat32_sector(label: &[u8; 11]) -> Vec<u8> {
        let mut sector = vec![0u8; 512];
        sector[0x47..0x52].copy_from_slice(label);
        sector[0x52..0x5a].copy_from_slice(b"FAT32   ");
        sector
    }

    #[test]
    fn hides_the_hai_stick_and_flags_small_disks() {
        let dir = tempfile::tempdir().unwrap();
        let (sys, dev) = (dir.path().join("sys"), dir.path().join("dev"));
        std::fs::create_dir_all(&dev).unwrap();

        add_block(&sys, "sda", 1_073_741_824, &[("model", "Stick")]);
        add_partition(&sys, "sda", "sda1");
        std::fs::write(dev.join("sda1"), fat32_sector(STICK_LABEL)).unwrap();

        add_block(&sys, "sdb", 34_359_738_368, &[("model", "Big")]);
        add_partition(&sys, "sdb", "sdb1");
        std::fs::write(dev.join("sdb1"), fat32_sector(b"EFI        ")).unwrap();

        add_block(&sys, "sdc", 8_589_934_592, &[("model", "Small")]);
        add_block(&sys, "sdd", 34_359_738_368, &[("model", "Unreadable")]);
        add_partition(&sys, "sdd", "sdd1"); // no /dev/sdd1, so it can't be checked
        add_block(&sys, "sr0", 1_000_000, &[]);

        let review = review(drives::list_with(&sys, &fake_link).unwrap(), &sys, &dev);

        let shown: Vec<(&str, Option<&str>)> = review
            .choices
            .iter()
            .map(|c| (c.disk.name.as_str(), c.problem))
            .collect();
        assert_eq!(shown, [("sdb", None), ("sdc", Some("smaller than 32 GB"))]);
        assert!(review.hidden.contains(&("sda".into(), "HAI live stick")));
        assert!(review
            .hidden
            .contains(&("sdd".into(), "partitions can't be checked")));
        assert!(review.hidden.contains(&("sr0".into(), "optical drive")));
    }

    #[test]
    fn refuses_a_swapped_disk_with_the_same_name_model_and_size() {
        let dir = tempfile::tempdir().unwrap();
        let (sys, dev) = (dir.path().join("sys"), dir.path().join("dev"));
        std::fs::create_dir_all(&dev).unwrap();
        let disk = |serial: &str| {
            add_block(
                &sys,
                "nvme0n1",
                64_000_000_000,
                &[("model", "SSD"), ("serial", serial)],
            );
            drives::list_with(&sys, &fake_link).unwrap()
        };

        let picked = match &disk("AAA")[0] {
            Entry::Disk(d) => d.clone(),
            other => panic!("{other:?}"),
        };
        assert!(still_usable(&picked, disk("AAA"), &sys, &dev));
        assert!(!still_usable(&picked, disk("BBB"), &sys, &dev));
    }

    #[test]
    fn size_limit_allows_nominal_32_gb_disks() {
        const { assert!(31_000_000_000 >= MIN_SIZE_BYTES) };
        const { assert!(30_000_000_000 < MIN_SIZE_BYTES) };
    }
}
