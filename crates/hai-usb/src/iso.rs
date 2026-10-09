//! Reads the official Alpine ISO and writes our own UEFI-bootable ISO.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;

use hadris_iso::boot::options::{BootEntryOptions, BootOptions, BootSectionOptions};
use hadris_iso::boot::{EmulationType, PlatformId};
use hadris_iso::directory::DirectoryRef;
use hadris_iso::read::{IsoImage, PathSeparator};
use hadris_iso::write::options::{CreationFeatures, HybridBootOptions, IsoFormatOptions};
use hadris_iso::write::{
    FileSource, InputEntry, InputEntryKind, InputMetadata, InputTree, IsoImageWriter,
};

use crate::stick_file::{Source, StickFile};
use crate::{Error, Result};

const ISO_SECTOR: u64 = 2048;
/// Alpine's EFI boot image: a small FAT image holding `efi/boot/bootx64.efi`.
const EFI_IMAGE: &str = "boot/grub/efi.img";

type Image = IsoImage<BufReader<File>>;

fn iso_error(error: impl std::fmt::Display) -> Error {
    Error::Iso(error.to_string())
}

fn open(iso: &Path) -> Result<Image> {
    IsoImage::open(BufReader::new(File::open(iso)?)).map_err(iso_error)
}

/// The volume label of `iso`, for example `alpine-std 3.24.2 x86_64`.
pub fn read_label(iso: &Path) -> Result<String> {
    let pvd = open(iso)?.read_pvd().map_err(iso_error)?;
    Ok(pvd.volume_identifier.to_str().trim_end().to_string())
}

/// Copies every file in `iso` into `out`.
pub fn extract(iso: &Path, out: &Path) -> Result<()> {
    let image = open(iso)?;
    let mut data = File::open(iso)?;
    extract_dir(&image, image.root_dir().dir_ref(), &mut data, out)
}

fn extract_dir(image: &Image, dir: DirectoryRef, data: &mut File, out: &Path) -> Result<()> {
    fs::create_dir_all(out)?;
    for entry in image.open_dir(dir).entries() {
        let entry = entry.map_err(iso_error)?;
        if entry.is_special() {
            continue;
        }
        let path = out.join(safe_name(&entry.display_name())?);
        if entry.is_directory() {
            extract_dir(
                image,
                entry.as_dir_ref(image).map_err(iso_error)?,
                data,
                &path,
            )?;
        } else {
            let mut file = File::create(&path)?;
            for extent in entry.extents() {
                data.seek(SeekFrom::Start(extent.sector.0 as u64 * ISO_SECTOR))?;
                io::copy(&mut (&mut *data).take(extent.length as u64), &mut file)?;
            }
        }
    }
    Ok(())
}

/// Strips the ISO version suffix (`;1`) and rejects names that could escape the output folder.
fn safe_name(raw: &str) -> Result<String> {
    let name = raw
        .split(';')
        .next()
        .unwrap_or_default()
        .trim_end_matches('.');
    if name.is_empty() || name == ".." || name.contains(['/', '\\', '\0']) {
        return Err(Error::Iso(format!("unsafe file name in ISO: {raw:?}")));
    }
    Ok(name.to_string())
}

/// Writes `src` plus `extra` root files to `out` as a UEFI-bootable ISO labelled `label`.
///
/// The label must match the Alpine ISO's: Alpine's GRUB searches for it to find its config.
pub fn build(src: &Path, extra: &[StickFile], label: &str, out: &Path) -> Result<()> {
    let mut entries = tree_from_dir(src)?;
    for item in extra {
        let kind = match &item.source {
            Source::Bytes(bytes) => InputEntryKind::File(bytes.clone()),
            Source::File(path) => InputEntryKind::Source(FileSource::from_path(path)?),
        };
        entries.push(entry(item.name.clone(), kind, 0o644));
    }

    let efi = BootEntryOptions {
        boot_image_path: EFI_IMAGE.to_string(),
        load_size: None,
        boot_info_table: false,
        grub2_boot_info: false,
        emulation: EmulationType::NoEmulation,
    };
    let features = CreationFeatures {
        el_torito: Some(BootOptions {
            write_boot_catalog: true,
            default: efi.clone(),
            entries: vec![(
                BootSectionOptions {
                    platform: PlatformId::UEFI,
                },
                efi,
            )],
        }),
        // Lets the ISO also boot when written raw to a USB stick (by Etcher, dd, etc.).
        hybrid_boot: Some(HybridBootOptions::gpt()),
        ..CreationFeatures::extensions()
    };
    let options = IsoFormatOptions {
        volume_name: label.to_string(),
        system_id: Some("LINUX".to_string()),
        volume_set_id: None,
        publisher_id: None,
        preparer_id: None,
        application_id: None,
        sector_size: ISO_SECTOR as usize,
        path_separator: PathSeparator::ForwardSlash,
        features,
        strict_charset: false,
    };

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(out)?;
    let tree = InputTree::new(PathSeparator::ForwardSlash, entries);
    IsoImageWriter::create(file, tree, options).map_err(iso_error)?;
    Ok(())
}

/// Files are streamed from disk while the ISO is written, so large files never sit in memory.
fn tree_from_dir(dir: &Path) -> Result<Vec<InputEntry>> {
    let mut entries = Vec::new();
    for item in fs::read_dir(dir)? {
        let item = item?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|name| Error::Iso(format!("non-UTF-8 file name: {name:?}")))?;
        entries.push(if item.file_type()?.is_dir() {
            entry(
                name,
                InputEntryKind::Directory(tree_from_dir(&item.path())?),
                0o755,
            )
        } else {
            entry(
                name,
                InputEntryKind::Source(FileSource::from_path(item.path())?),
                0o644,
            )
        });
    }
    Ok(entries)
}

fn entry(name: String, kind: InputEntryKind, mode: u32) -> InputEntry {
    InputEntry {
        name: Arc::new(name),
        kind,
        metadata: InputMetadata {
            mode: Some(mode),
            uid: Some(0),
            gid: Some(0),
            ..InputMetadata::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trip_keeps_names_content_and_label() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(src.join("boot/grub")).unwrap();
        std::fs::write(src.join("boot/grub/efi.img"), vec![1u8; 4096]).unwrap();
        std::fs::write(src.join("boot/vmlinuz-lts"), b"kernel").unwrap();
        let big = dir.path().join("big.bin");
        std::fs::write(&big, vec![9u8; 3 * 1024 * 1024]).unwrap();
        let extra = [
            StickFile {
                name: "hai.apkovl.tar.gz".into(),
                source: Source::Bytes(b"ovl".to_vec()),
            },
            StickFile {
                name: "haos_generic-x86-64-18.3.img.xz".into(),
                source: Source::File(big),
            },
        ];
        let iso = dir.path().join("out.iso");

        build(&src, &extra, "alpine-std 3.24.2 x86_64", &iso).unwrap();
        assert_eq!(read_label(&iso).unwrap(), "alpine-std 3.24.2 x86_64");

        let back = dir.path().join("back");
        extract(&iso, &back).unwrap();
        assert_eq!(
            std::fs::read(back.join("boot/vmlinuz-lts")).unwrap(),
            b"kernel"
        );
        assert_eq!(
            std::fs::read(back.join("hai.apkovl.tar.gz")).unwrap(),
            b"ovl"
        );
        assert_eq!(
            std::fs::read(back.join("haos_generic-x86-64-18.3.img.xz")).unwrap(),
            vec![9u8; 3 * 1024 * 1024]
        );
    }

    #[test]
    fn unsafe_names_are_rejected() {
        assert_eq!(safe_name("VMLINUZ.;1").unwrap(), "VMLINUZ");
        assert_eq!(safe_name("apks").unwrap(), "apks");
        for bad in ["..", "../x", "a/b", "a\\b", ""] {
            assert!(safe_name(bad).is_err(), "{bad}");
        }
    }
}
