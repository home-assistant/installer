//! Live USB stick and ISO that install Home Assistant OS on a generic x86-64 PC.
//!
//! Assembles the stick contents (the official Alpine ISO, an overlay that starts `hai-live`,
//! and the HAOS image) and turns them into an ISO or a raw disk image.

mod apkovl;
mod disk_image;
mod downloads;
mod iso;

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::{ProgressCallback, ReleaseSource};

pub use downloads::{cache_dir, fetch_alpine, fetch_haos, Download, ALPINE_VERSION, HAOS_BOARD};

/// Remove everything the live USB flow downloaded and unpacked into `cache`, the
/// installer's cache folder. For after a stick or ISO is made: people make one, so
/// nothing is kept for a next time. Until then it stays, so trying again doesn't
/// download it all again.
pub fn remove_cache(cache: &Path) -> Result<()> {
    match std::fs::remove_dir_all(cache.join(downloads::FOLDER)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

/// Everything that goes on the stick, ready to be written out.
#[derive(Debug, Clone)]
pub struct Contents {
    /// Unpacked Alpine ISO files.
    files: PathBuf,
    /// Our files at the root: apkovl, HAOS image and its checksum.
    extra: Vec<StickFile>,
    /// Alpine's ISO volume label, which our ISO must keep.
    label: String,
    /// HAOS version on the stick.
    pub haos_version: String,
}

impl Contents {
    fn stem(&self) -> String {
        format!("hai-live-haos-{}", self.haos_version)
    }
}

/// Where a stick file's bytes come from.
#[derive(Debug, Clone)]
enum Source {
    /// Small generated content, held in memory.
    Bytes(Vec<u8>),
    /// A file on disk, streamed so large files (HAOS) never sit in memory.
    File(PathBuf),
}

/// A file placed at the root of the boot media, on top of the Alpine ISO contents.
#[derive(Debug, Clone)]
struct StickFile {
    /// File name at the root of the boot media.
    name: String,
    /// Content.
    source: Source,
}

impl StickFile {
    /// Size in bytes.
    fn size(&self) -> std::io::Result<u64> {
        match &self.source {
            Source::Bytes(bytes) => Ok(bytes.len() as u64),
            Source::File(path) => Ok(std::fs::metadata(path)?.len()),
        }
    }
}

/// Downloads (or reuses) Alpine and HAOS and assembles the stick contents.
/// `hai_live` is the static Linux build of the `hai-live` program.
pub async fn prepare<B: ReleaseSource, P: ProgressCallback>(
    backend: &B,
    hai_live: &Path,
    progress: &P,
) -> Result<Contents> {
    let hai_live = std::fs::read(hai_live)?;
    if !is_static_x86_64_elf(&hai_live) {
        return Err(Error::LiveUsbInvalidHaiLive);
    }

    let cache = downloads::cache_dir(backend)?;
    let alpine = downloads::fetch_alpine(backend, &cache, progress).await?;
    let haos = downloads::fetch_haos(backend, &cache, progress).await?;

    let files = unpack_alpine(&cache, &alpine)?;
    // Also on an earlier unpacked copy, so a cache from before this still gets the new title
    retitle_boot_menu(&files.join("boot/grub/grub.cfg"))?;
    let label = iso::read_label(&alpine.path)?;
    let haos_name = haos
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| Error::LiveUsbBuild("HAOS file name is not valid UTF-8".into()))?
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

/// GRUB shows the menu entry's title while it starts the stick ("Booting `Linux lts'"). Name it
/// after what the stick is. Only titles change, so the kernel arguments keep following Alpine;
/// without a GRUB config there is nothing to rename.
fn retitle_boot_menu(grub_cfg: &Path) -> Result<()> {
    let Ok(config) = std::fs::read_to_string(grub_cfg) else {
        return Ok(());
    };
    let retitled: String = config
        .lines()
        .map(|line| match line.strip_prefix("menuentry \"") {
            Some(rest) => match rest.split_once('"') {
                Some((_, after)) => format!("menuentry \"{BOOT_MENU_TITLE}\"{after}\n"),
                None => format!("{line}\n"),
            },
            None => format!("{line}\n"),
        })
        .collect();
    if retitled != config {
        std::fs::write(grub_cfg, retitled)?;
    }
    Ok(())
}

/// What GRUB says it is starting.
const BOOT_MENU_TITLE: &str = "Home Assistant Installer";

/// Whether the file at `path` is the static Linux build of `hai-live` that the stick can run.
pub fn is_usable_hai_live(path: &Path) -> bool {
    std::fs::read(path).is_ok_and(|bin| is_static_x86_64_elf(&bin))
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
    fn usable_hai_live_checks_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hai-live");
        assert!(!is_usable_hai_live(&path), "missing");
        std::fs::write(&path, elf(2, 0x3e, 3)).unwrap();
        assert!(!is_usable_hai_live(&path), "dynamic");
        std::fs::write(&path, elf(2, 0x3e, 1)).unwrap();
        assert!(is_usable_hai_live(&path));
    }

    #[test]
    fn names_the_boot_menu_after_the_installer() {
        let dir = tempfile::tempdir().unwrap();
        let grub_cfg = dir.path().join("grub.cfg");
        // Alpine 3.24's boot/grub/grub.cfg
        std::fs::write(
            &grub_cfg,
            "set timeout=1\n\nmenuentry \"Linux lts\" {\nlinux\t/boot/vmlinuz-lts modules=loop,squashfs,sd-mod,usb-storage quiet \ninitrd\t/boot/initramfs-lts\n}\n",
        )
        .unwrap();

        retitle_boot_menu(&grub_cfg).unwrap();
        let config = std::fs::read_to_string(&grub_cfg).unwrap();
        assert!(config.contains("menuentry \"Home Assistant Installer\" {"));
        assert!(config
            .contains("linux\t/boot/vmlinuz-lts modules=loop,squashfs,sd-mod,usb-storage quiet"));
        assert!(!config.contains("Linux lts"));

        // A second time changes nothing, and no config is fine
        retitle_boot_menu(&grub_cfg).unwrap();
        assert_eq!(std::fs::read_to_string(&grub_cfg).unwrap(), config);
        retitle_boot_menu(&dir.path().join("missing.cfg")).unwrap();
    }

    #[test]
    fn removing_the_cache_takes_only_the_live_usb_folder() {
        let cache = tempfile::tempdir().unwrap();
        let live = cache.path().join("live-usb");
        std::fs::create_dir_all(live.join("haos").join("18.3")).unwrap();
        std::fs::write(live.join("haos").join("18.3").join("haos.img.xz"), b"image").unwrap();
        std::fs::write(cache.path().join("other"), b"other").unwrap();

        remove_cache(cache.path()).unwrap();
        assert!(!live.exists());
        assert!(cache.path().join("other").exists());
        // Nothing to remove is fine too
        remove_cache(cache.path()).unwrap();
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

    /// Builds a real ISO and disk image, without writing to any disk. Set `LIVE_USB_OUT_DIR`
    /// to keep the files; otherwise they go to a temporary folder.
    #[tokio::test]
    #[ignore = "downloads Alpine and HAOS and needs HAI_LIVE_PATH; run explicitly"]
    async fn builds_iso_and_disk_image() {
        let hai_live = std::env::var_os("HAI_LIVE_PATH")
            .expect("set HAI_LIVE_PATH to the Linux build of hai-live");
        let temp = tempfile::tempdir().unwrap();
        let out = std::env::var_os("LIVE_USB_OUT_DIR")
            .map_or_else(|| temp.path().to_path_buf(), PathBuf::from);

        let contents = prepare(&crate::Backend, Path::new(&hai_live), &crate::NoOpProgress)
            .await
            .unwrap();
        let iso = write_iso(&contents, &out).unwrap();
        let image = write_image(&contents, &out).unwrap();

        assert_eq!(iso::read_label(&iso).unwrap(), contents.label);
        assert!(std::fs::metadata(&image).unwrap().len() > 0);
        println!("ISO: {}\nDisk image: {}", iso.display(), image.display());
    }
}
