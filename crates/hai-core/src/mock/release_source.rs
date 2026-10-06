//! `ReleaseSource` mock: canned release/manifest data and simulated
//! download/extract that write a placeholder file.

use std::path::{Path, PathBuf};

use crate::types::{DeviceManifest, FlashStage, HaosImage, HaosRelease, ImageFormat, UpdateInfo};
use crate::{ProgressCallback, ReleaseSource, Result};

use super::{simulate, simulate_indeterminate, touch_placeholder, BackendMock};

fn mock_update_info() -> UpdateInfo {
    UpdateInfo {
        update_available: false,
        current_version: "0.1.0".to_string(),
        latest_version: "0.1.0".to_string(),
        download_url: Some(
            "https://github.com/home-assistant/home-assistant-installer/releases".to_string(),
        ),
        release_notes_url: Some(
            "https://github.com/home-assistant/home-assistant-installer/releases".to_string(),
        ),
        is_beta: false,
    }
}

fn mock_haos_release() -> HaosRelease {
    HaosRelease {
        version: "16.3".to_string(),
        images: vec![
            HaosImage {
                board: "rpi5-64".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_rpi5-64-16.3.img.xz".to_string(),
                size: 331_899_792,
            },
            HaosImage {
                board: "rpi4-64".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_rpi4-64-16.3.img.xz".to_string(),
                size: 322_239_272,
            },
            HaosImage {
                board: "rpi3-64".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_rpi3-64-16.3.img.xz".to_string(),
                size: 311_438_560,
            },
            HaosImage {
                board: "odroid-n2".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_odroid-n2-16.3.img.xz".to_string(),
                size: 298_412_092,
            },
            HaosImage {
                board: "green".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_green-16.3.img.xz".to_string(),
                size: 336_860_104,
            },
            HaosImage {
                board: "yellow".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_yellow-16.3.img.xz".to_string(),
                size: 322_261_788,
            },
            HaosImage {
                board: "generic-x86-64".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_generic-x86-64-16.3.img.xz".to_string(),
                size: 396_451_208,
            },
            HaosImage {
                board: "generic-aarch64".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_generic-aarch64-16.3.img.xz".to_string(),
                size: 341_537_340,
            },
            HaosImage {
                board: "generic-x86-64".to_string(),
                format: ImageFormat::Qcow2,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_generic-x86-64-16.3.qcow2.xz".to_string(),
                size: 396_000_000,
            },
            HaosImage {
                board: "generic-aarch64".to_string(),
                format: ImageFormat::Qcow2,
                download_url: "https://github.com/home-assistant/operating-system/releases/download/16.3/haos_generic-aarch64-16.3.qcow2.xz".to_string(),
                size: 341_000_000,
            },
        ],
    }
}

impl ReleaseSource for BackendMock {
    async fn get_device_manifest(&self) -> Result<DeviceManifest> {
        Ok(crate::manifest::bundled_manifest())
    }

    async fn get_haos_release(&self, _version: &str) -> Result<HaosRelease> {
        Ok(mock_haos_release())
    }

    async fn download_image<P: ProgressCallback>(
        &self,
        _url: &str,
        dest_path: &Path,
        progress_callback: &P,
    ) -> Result<()> {
        simulate(
            progress_callback,
            FlashStage::Downloading,
            "Downloading image (mock)...",
            250,
        )
        .await;
        touch_placeholder(dest_path)
    }

    async fn extract_xz<P: ProgressCallback>(
        &self,
        _archive_path: &Path,
        dest_path: &Path,
        progress_callback: &P,
    ) -> Result<()> {
        simulate_indeterminate(
            progress_callback,
            FlashStage::Extracting,
            "Extracting image (mock)...",
            250,
        )
        .await;
        touch_placeholder(dest_path)
    }

    async fn check_for_updates(&self) -> Result<UpdateInfo> {
        Ok(mock_update_info())
    }

    /// Keeps placeholder files out of the user's real image cache.
    fn cache_dir(&self) -> Result<PathBuf> {
        let dir = std::env::temp_dir().join("hai-mock");
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }
}
