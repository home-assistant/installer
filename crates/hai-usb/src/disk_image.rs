//! Raw disk image for a USB stick: GPT with one FAT32 EFI System Partition.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;

use fatfs::{FatType, FormatVolumeOptions, FsOptions};
use fscommon::{BufStream, StreamSlice};
use gpt::disk::LogicalBlockSize;
use gpt::mbr::ProtectiveMBR;

use crate::stick_file::{Source, StickFile};
use crate::{Error, Result};

const SECTOR: u64 = 512;
const MIB: u64 = 1024 * 1024;
/// FAT labels are 11 bytes, space padded. `hai-live` finds its own stick by this label.
pub const VOLUME_LABEL: &[u8; 11] = b"HAI-LIVE   ";

/// Writes a disk image to `out`: everything under `src`, plus `extra` at the partition root.
/// The image is sized to fit the content with some headroom.
pub fn build(out: &Path, src: &Path, extra: &[StickFile]) -> Result<()> {
    let size = image_size(src, extra)?;
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(out)?;
    file.set_len(size)?;

    let (start, end) = write_partition_table(&mut file, size)?;
    let mut part = StreamSlice::new(BufStream::new(file), start, end)?;
    fatfs::format_volume(
        &mut part,
        FormatVolumeOptions::new()
            .fat_type(FatType::Fat32)
            .volume_label(*VOLUME_LABEL),
    )?;

    let fs = fatfs::FileSystem::new(part, FsOptions::new())?;
    {
        let root = fs.root_dir();
        copy_dir(src, &root)?;
        for item in extra {
            let mut f = root.create_file(&item.name)?;
            f.truncate()?;
            match &item.source {
                Source::Bytes(bytes) => f.write_all(bytes)?,
                Source::File(path) => {
                    std::io::copy(&mut File::open(path)?, &mut f)?;
                }
            }
        }
    }
    fs.unmount()?;
    Ok(())
}

/// Content size plus 10% and 64 MiB for FAT overhead, rounded up to whole MiB.
fn image_size(src: &Path, extra: &[StickFile]) -> Result<u64> {
    let mut content = dir_size(src)?;
    for item in extra {
        let size = item.size()?;
        if size > u64::from(u32::MAX) {
            return Err(Error::DiskImage(format!(
                "{} is larger than the 4 GiB FAT32 file limit",
                item.name
            )));
        }
        content = content.saturating_add(size);
    }
    let size = content
        .saturating_add(content / 10)
        .saturating_add(64 * MIB);
    Ok(size.div_ceil(MIB).saturating_mul(MIB))
}

fn dir_size(dir: &Path) -> Result<u64> {
    let mut total: u64 = 0;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        total = total.saturating_add(if entry.file_type()?.is_dir() {
            dir_size(&entry.path())?
        } else {
            entry.metadata()?.len()
        });
    }
    Ok(total)
}

/// Writes a protective MBR and GPT; returns the ESP's byte range.
fn write_partition_table(file: &mut File, size: u64) -> Result<(u64, u64)> {
    let gpt_error = |e: gpt::GptError| Error::DiskImage(e.to_string());
    let sectors = size / SECTOR;
    ProtectiveMBR::with_lb_size(u32::try_from(sectors - 1).unwrap_or(u32::MAX))
        .overwrite_lba0(file)
        .map_err(|e| Error::DiskImage(e.to_string()))?;

    let mut disk = gpt::GptConfig::new()
        .writable(true)
        .logical_block_size(LogicalBlockSize::Lb512)
        .create_from_device(file, None)
        .map_err(gpt_error)?;
    // Leave 1 MiB at each end for the GPT headers and alignment.
    let id = disk
        .add_partition(
            "HAI-LIVE",
            size - 2 * MIB,
            gpt::partition_types::EFI,
            0,
            Some(2048),
        )
        .map_err(gpt_error)?;
    let part = disk.partitions()[&id].clone();
    disk.write().map_err(gpt_error)?;
    Ok((part.first_lba * SECTOR, (part.last_lba + 1) * SECTOR))
}

fn copy_dir<T: fatfs::ReadWriteSeek>(src: &Path, dst: &fatfs::Dir<T>) -> Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| Error::DiskImage(format!("non-UTF-8 file name: {name:?}")))?;
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dst.create_dir(name)?)?;
        } else {
            let mut f = dst.create_file(name)?;
            f.truncate()?;
            std::io::copy(&mut File::open(entry.path())?, &mut f)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn image_has_gpt_esp_with_all_files() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(src.join("boot/grub")).unwrap();
        std::fs::write(src.join("boot/grub/grub.cfg"), b"set timeout=1\n").unwrap();
        let big = dir.path().join("big.bin");
        std::fs::write(&big, vec![7u8; 3 * 1024 * 1024]).unwrap();
        let extra = [
            StickFile {
                name: "hai.apkovl.tar.gz".into(),
                source: Source::Bytes(b"ovl".to_vec()),
            },
            StickFile {
                name: "haos_test.img.xz".into(),
                source: Source::File(big),
            },
        ];
        let out = dir.path().join("stick.img");

        build(&out, &src, &extra).unwrap();

        let disk = gpt::GptConfig::new().open(&out).unwrap();
        let (_, part) = disk.partitions().iter().next().unwrap();
        assert_eq!(part.part_type_guid, gpt::partition_types::EFI);

        let file = File::open(&out).unwrap();
        let slice =
            StreamSlice::new(file, part.first_lba * SECTOR, (part.last_lba + 1) * SECTOR).unwrap();
        let fs = fatfs::FileSystem::new(slice, FsOptions::new()).unwrap();
        assert_eq!(fs.fat_type(), FatType::Fat32);
        assert_eq!(&fs.volume_label(), "HAI-LIVE");

        let read = |path: &str| {
            let mut data = Vec::new();
            fs.root_dir()
                .open_file(path)
                .unwrap()
                .read_to_end(&mut data)
                .unwrap();
            data
        };
        assert_eq!(read("boot/grub/grub.cfg"), b"set timeout=1\n");
        assert_eq!(read("hai.apkovl.tar.gz"), b"ovl");
        assert_eq!(read("haos_test.img.xz"), vec![7u8; 3 * 1024 * 1024]);
    }
}
