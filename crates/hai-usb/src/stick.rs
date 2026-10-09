//! Assembles the stick contents and turns them into an ISO, a disk image, or a written USB stick.

use std::path::{Path, PathBuf};

use hai_core::{ExpectedDevice, ProgressCallback};

use crate::stick_file::{Source, StickFile};
use crate::{apkovl, disk_image, downloads, iso, usb, Error, Result};

/// Everything that goes on the stick, ready to be written out.
#[derive(Debug, Clone)]
pub struct Contents {
    /// Unpacked Alpine ISO files.
    files: PathBuf,
    /// Our files at the root: apkovl, HAOS image and its checksum.
    extra: Vec<StickFile>,
    /// Alpine's ISO volume label, which our ISO must keep.
    label: String,
    /// The cache folder, used for the temporary image when writing a stick.
    cache: PathBuf,
    /// HAOS version on the stick.
    pub haos_version: String,
}

impl Contents {
    fn stem(&self) -> String {
        format!("hai-live-haos-{}", self.haos_version)
    }
}

/// Downloads (or reuses) Alpine and HAOS and assembles the stick contents.
/// `hai_live` is the static Linux build of the `hai-live` program.
pub async fn prepare<P: ProgressCallback>(hai_live: &Path, progress: &P) -> Result<Contents> {
    let hai_live = std::fs::read(hai_live)?;
    if !is_static_x86_64_elf(&hai_live) {
        return Err(Error::NotLinuxBinary);
    }

    let cache = downloads::cache_dir()?;
    let alpine = downloads::fetch_alpine(&cache, progress).await?;
    let haos = downloads::fetch_haos(&cache, progress).await?;

    let files = unpack_alpine(&cache, &alpine)?;
    let label = iso::read_label(&alpine.path)?;
    let haos_name = haos
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| Error::Iso("HAOS file name is not valid UTF-8".into()))?
        .to_string();

    let extra = vec![
        StickFile {
            name: apkovl::APKOVL_NAME.into(),
            source: Source::Bytes(apkovl::build(&hai_live)?),
        },
        StickFile {
            name: format!("{haos_name}.sha256"),
            // Same format as `sha256sum`, so it can also be checked by hand on the stick.
            source: Source::Bytes(format!("{}  {haos_name}\n", haos.sha256).into_bytes()),
        },
        StickFile {
            name: haos_name,
            source: Source::File(haos.path.clone()),
        },
    ];

    Ok(Contents {
        files,
        extra,
        label,
        cache,
        haos_version: haos.version,
    })
}

/// Writes `<out_dir>/hai-live-haos-<version>.iso` and returns its path.
pub fn write_iso(contents: &Contents, out_dir: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(out_dir)?;
    let path = out_dir.join(format!("{}.iso", contents.stem()));
    iso::build(&contents.files, &contents.extra, &contents.label, &path)?;
    Ok(path)
}

/// Writes `<out_dir>/hai-live-haos-<version>.img` (a raw disk image, handy for VMs) and returns its path.
pub fn write_image(contents: &Contents, out_dir: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(out_dir)?;
    let path = out_dir.join(format!("{}.img", contents.stem()));
    disk_image::build(&path, &contents.files, &contents.extra)?;
    Ok(path)
}

/// Builds the stick image in a temporary folder, writes it to the USB drive `device_id`
/// with read-back verification, then deletes the temporary image.
pub async fn write_stick<P: ProgressCallback>(
    contents: &Contents,
    device_id: &str,
    expected: &ExpectedDevice,
    progress: &P,
) -> Result<()> {
    // Deleted when it goes out of scope, also on error.
    let temp = tempfile::Builder::new()
        .prefix("usb-image-")
        .tempdir_in(&contents.cache)?;
    let image = write_image(contents, temp.path())?;
    usb::write_to_usb(&image, device_id, expected, progress).await
}

/// Unpacks the Alpine ISO into the cache once per version and returns the folder.
fn unpack_alpine(cache: &Path, alpine: &downloads::Download) -> Result<PathBuf> {
    let dir = cache
        .join("work")
        .join(format!("alpine-{}", alpine.version));
    // The marker holds the checksum of the ISO it was unpacked from, so a re-downloaded
    // ISO with the same version (or a half-written marker) gets unpacked again.
    let done = dir.join(".unpacked");
    if std::fs::read(&done).is_ok_and(|marker| marker == alpine.sha256.as_bytes()) {
        return Ok(dir.join("files"));
    }
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    iso::extract(&alpine.path, &dir.join("files"))?;
    std::fs::write(&done, alpine.sha256.as_bytes())?;
    Ok(dir.join("files"))
}

/// Whether `bin` is a 64-bit little-endian x86-64 ELF program with an entry point, at least one
/// loadable segment and no dynamic loader (`PT_INTERP`), i.e. something the live stick can run as is.
fn is_static_x86_64_elf(bin: &[u8]) -> bool {
    const ET_EXEC: u16 = 2;
    const ET_DYN: u16 = 3; // static-pie, which is what musl builds produce
    const PT_LOAD: u32 = 1;
    const PT_INTERP: u32 = 3;
    let u16_at = |at: usize| -> Option<u16> {
        Some(u16::from_le_bytes(
            bin.get(at..at.checked_add(2)?)?.try_into().ok()?,
        ))
    };
    let u32_at = |at: usize| -> Option<u32> {
        Some(u32::from_le_bytes(
            bin.get(at..at.checked_add(4)?)?.try_into().ok()?,
        ))
    };
    let u64_at = |at: usize| -> Option<u64> {
        Some(u64::from_le_bytes(
            bin.get(at..at.checked_add(8)?)?.try_into().ok()?,
        ))
    };

    let header_ok = bin.starts_with(b"\x7fELF")
        && bin.get(4) == Some(&2) // 64-bit
        && bin.get(5) == Some(&1) // little endian
        && matches!(u16_at(16), Some(ET_EXEC | ET_DYN))
        && u16_at(18) == Some(0x3e) // x86-64
        && u64_at(0x18).is_some_and(|entry| entry != 0);
    if !header_ok {
        return false;
    }
    let (Some(phoff), Some(phentsize), Some(phnum)) = (u64_at(0x20), u16_at(0x36), u16_at(0x38))
    else {
        return false;
    };
    let Ok(phoff) = usize::try_from(phoff) else {
        return false;
    };
    const PHENTSIZE: usize = 56; // ELF64 program header size
    let table_end = usize::from(phnum)
        .checked_mul(PHENTSIZE)
        .and_then(|len| phoff.checked_add(len));
    if usize::from(phentsize) != PHENTSIZE || table_end.is_none_or(|end| end > bin.len()) {
        return false;
    }
    let types: Option<Vec<u32>> = (0..usize::from(phnum))
        .map(|i| u32_at(phoff + i * PHENTSIZE))
        .collect();
    types.is_some_and(|types| types.contains(&PT_LOAD) && !types.contains(&PT_INTERP))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal ELF header with one program header of type `p_type`.
    fn elf(class: u8, machine: u16, p_type: u32) -> Vec<u8> {
        let mut bin = vec![0u8; 64 + 56];
        bin[..4].copy_from_slice(b"\x7fELF");
        bin[4] = class;
        bin[5] = 1;
        bin[16..18].copy_from_slice(&2u16.to_le_bytes());
        bin[18..20].copy_from_slice(&machine.to_le_bytes());
        bin[0x18..0x20].copy_from_slice(&0x40_1000u64.to_le_bytes());
        bin[0x20..0x28].copy_from_slice(&64u64.to_le_bytes());
        bin[0x36..0x38].copy_from_slice(&56u16.to_le_bytes());
        bin[0x38..0x3a].copy_from_slice(&1u16.to_le_bytes());
        bin[64..68].copy_from_slice(&p_type.to_le_bytes());
        bin
    }

    #[test]
    fn accepts_only_static_x86_64_elf() {
        assert!(is_static_x86_64_elf(&elf(2, 0x3e, 1)));
        assert!(
            !is_static_x86_64_elf(&elf(2, 0x3e, 3)),
            "dynamically linked"
        );
        assert!(!is_static_x86_64_elf(&elf(2, 0xb7, 1)), "aarch64");
        assert!(!is_static_x86_64_elf(&elf(1, 0x3e, 1)), "32-bit");
        assert!(!is_static_x86_64_elf(b"MZ\x90\x00"), "Windows exe");
        assert!(!is_static_x86_64_elf(&elf(2, 0x3e, 1)[..66]), "truncated");

        let changed = |at: usize, bytes: &[u8]| {
            let mut bin = elf(2, 0x3e, 1);
            bin[at..at + bytes.len()].copy_from_slice(bytes);
            bin
        };
        assert!(is_static_x86_64_elf(&changed(16, &[3, 0])), "static-pie");
        assert!(!is_static_x86_64_elf(&changed(16, &[1, 0])), "object file");
        assert!(
            !is_static_x86_64_elf(&changed(0x18, &[0; 8])),
            "no entry point"
        );
        assert!(
            !is_static_x86_64_elf(&changed(0x38, &[0, 0])),
            "no program headers"
        );
        assert!(!is_static_x86_64_elf(&elf(2, 0x3e, 6)), "no PT_LOAD");
        assert!(
            !is_static_x86_64_elf(&elf(2, 0x3e, 1)[..100]),
            "program header table cut off"
        );
        assert!(
            !is_static_x86_64_elf(&changed(0x36, &[4, 0])),
            "wrong program header size"
        );
        let huge = (usize::MAX as u64 - 1).to_le_bytes();
        assert!(
            !is_static_x86_64_elf(&changed(0x20, &huge)),
            "e_phoff at the end of memory"
        );
    }

    #[test]
    fn unpacks_again_when_the_marker_does_not_match() {
        let cache = tempfile::tempdir().unwrap();
        let alpine = downloads::Download {
            path: cache.path().join("missing.iso"),
            version: "3.24.2".into(),
            sha256: "abc".into(),
        };
        let dir = cache.path().join("work").join("alpine-3.24.2");
        std::fs::create_dir_all(dir.join("files")).unwrap();

        std::fs::write(dir.join(".unpacked"), "abc").unwrap();
        assert_eq!(
            unpack_alpine(cache.path(), &alpine).unwrap(),
            dir.join("files")
        );

        // Different checksum: the old files are dropped and extraction is tried (and fails,
        // because the test ISO doesn't exist).
        std::fs::write(dir.join(".unpacked"), "old").unwrap();
        assert!(unpack_alpine(cache.path(), &alpine).is_err());
        assert!(!dir.join(".unpacked").exists());
    }
}
