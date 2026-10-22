//! `ReleaseSource` mock: canned release/manifest data and simulated
//! download/extract that write a placeholder file.

use std::path::{Path, PathBuf};

use crate::types::{DeviceManifest, FlashStage, HaosImage, HaosRelease, ImageFormat};
use crate::{ProgressCallback, ReleaseSource, Result};

use super::{simulate, BackendMock};

/// A raw image with only what the flash looks at inside one: a GPT naming a
/// FAT `hassos-boot` partition, where Wi-Fi settings are added.
fn write_boot_image(path: &Path) -> Result<()> {
    const BOOT_SECTOR: usize = 2048;
    const BOOT_SIZE: usize = 4 * 1024 * 1024;
    let mut image = vec![0u8; BOOT_SECTOR * 512 + BOOT_SIZE];
    image[512..520].copy_from_slice(b"EFI PART");
    image[512 + 72..512 + 80].copy_from_slice(&2u64.to_le_bytes());
    image[512 + 80..512 + 84].copy_from_slice(&1u32.to_le_bytes());
    image[512 + 84..512 + 88].copy_from_slice(&128u32.to_le_bytes());
    let entry = &mut image[1024..1152];
    entry[32..40].copy_from_slice(&(BOOT_SECTOR as u64).to_le_bytes());
    let last = (BOOT_SECTOR + BOOT_SIZE / 512 - 1) as u64;
    entry[40..48].copy_from_slice(&last.to_le_bytes());
    for (i, unit) in "hassos-boot".encode_utf16().enumerate() {
        entry[56 + 2 * i..58 + 2 * i].copy_from_slice(&unit.to_le_bytes());
    }
    fatfs::format_volume(
        std::io::Cursor::new(&mut image[BOOT_SECTOR * 512..]),
        fatfs::FormatVolumeOptions::new(),
    )?;
    std::fs::write(path, image)?;
    Ok(())
}

fn mock_haos_release() -> HaosRelease {
    HaosRelease {
        version: "16.3".to_string(),
        images: vec![
            HaosImage {
                board: "rpi5-64".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_rpi5-64-16.3.img.xz".to_string(),
                digest: None,
                size: 331_899_792,
            },
            HaosImage {
                board: "rpi4-64".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_rpi4-64-16.3.img.xz".to_string(),
                digest: None,
                size: 322_239_272,
            },
            HaosImage {
                board: "rpi3-64".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_rpi3-64-16.3.img.xz".to_string(),
                digest: None,
                size: 311_438_560,
            },
            HaosImage {
                board: "odroid-n2".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_odroid-n2-16.3.img.xz".to_string(),
                digest: None,
                size: 298_412_092,
            },
            HaosImage {
                board: "green".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_green-16.3.img.xz".to_string(),
                digest: None,
                size: 336_860_104,
            },
            HaosImage {
                board: "yellow".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_yellow-16.3.img.xz".to_string(),
                digest: None,
                size: 322_261_788,
            },
            HaosImage {
                board: "generic-x86-64".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_generic-x86-64-16.3.img.xz".to_string(),
                digest: None,
                size: 396_451_208,
            },
            HaosImage {
                board: "generic-aarch64".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_generic-aarch64-16.3.img.xz".to_string(),
                digest: None,
                size: 341_537_340,
            },
            HaosImage {
                board: "ova".to_string(),
                format: ImageFormat::Qcow2,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_ova-16.3.qcow2.xz".to_string(),
                digest: None,
                size: 396_000_000,
            },
            HaosImage {
                board: "generic-aarch64".to_string(),
                format: ImageFormat::Qcow2,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_generic-aarch64-16.3.qcow2.xz".to_string(),
                digest: None,
                size: 341_000_000,
            },
        ],
    }
}

impl ReleaseSource for BackendMock {
    async fn check_connection(&self) -> Result<()> {
        Ok(())
    }

    async fn get_device_manifest(&self) -> Result<DeviceManifest> {
        Ok(crate::manifest::bundled_manifest())
    }

    async fn get_haos_release(&self, _version: &str) -> Result<HaosRelease> {
        Ok(mock_haos_release())
    }

    async fn get_latest_haos_release_for_board(&self, _board: &str) -> Result<HaosRelease> {
        Ok(mock_haos_release())
    }

    async fn download_image<P: ProgressCallback>(
        &self,
        image: &HaosImage,
        dest_path: &Path,
        progress_callback: &P,
    ) -> Result<()> {
        simulate(
            progress_callback,
            FlashStage::Downloading,
            image.size,
            "Downloading image (mock)...",
        )
        .await?;
        // Sized like the image without writing it, for the extraction to measure
        std::fs::File::create(dest_path)?.set_len(image.size)?;
        Ok(())
    }

    async fn extract_xz<P: ProgressCallback>(
        &self,
        archive_path: &Path,
        dest_path: &Path,
        progress_callback: &P,
    ) -> Result<()> {
        simulate(
            progress_callback,
            FlashStage::Extracting,
            std::fs::metadata(archive_path)?.len(),
            "Extracting image (mock)...",
        )
        .await?;
        if dest_path.extension().is_some_and(|ext| ext == "img") {
            write_boot_image(dest_path)
        } else {
            Ok(std::fs::write(dest_path, b"mock-image-data")?)
        }
    }

    /// Keeps placeholder files out of the user's real image cache.
    fn cache_dir(&self) -> Result<PathBuf> {
        let dir = std::env::temp_dir().join("hai-mock");
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }
}
