//! Installer images for Home Assistant hardware by Nabu Casa
//!
//! The Green and Yellow are reset with a small installer image instead of
//! Home Assistant OS itself. Booted once, the installer writes Home Assistant
//! OS to the device's own storage.
//!
//! NabuCasa/buildroot-installer has no "latest" release API like the HAOS
//! version service, so these images are pinned on purpose. GitHub publishes no
//! digest for these older release assets: the SHA-256 digests below were
//! computed from the published files. They go through the same download path
//! as HAOS images, which checks the size and digest before extraction.

use crate::types::{HaosConfig, HaosImage, ImageFormat};

/// Nominal drive capacity an installer needs. The images are about 70 MB, so
/// this only keeps the storage checks meaningful: any card or stick fits, as
/// does the eMMC of a Yellow CM5. Recommended equals minimum, because the
/// installer never grows into the space.
const INSTALLER_STORAGE_BYTES: u64 = 1_000_000_000;

/// A pinned installer image for one Home Assistant hardware board.
#[derive(Debug, Clone, Copy)]
pub struct HardwareInstaller {
    /// Board identifier the frontend sends in a flash request.
    pub board: &'static str,
    pub download_url: &'static str,
    /// Size of the compressed `.img.xz` asset in bytes.
    pub size: u64,
    /// SHA-256 of the compressed asset, as `sha256:<hex>`.
    pub digest: &'static str,
    /// Size of the extracted raw image in bytes.
    pub extracted_size: u64,
}

impl HardwareInstaller {
    /// The image as the download pipeline expects it.
    pub fn image(&self) -> HaosImage {
        HaosImage {
            board: self.board.to_string(),
            format: ImageFormat::Raw,
            download_url: self.download_url.to_string(),
            size: self.size,
            digest: Some(self.digest.to_string()),
        }
    }

    /// Storage requirements for the drive the installer is written to.
    pub fn storage(&self) -> HaosConfig {
        HaosConfig {
            board: self.board.to_string(),
            download_url: self.download_url.to_string(),
            minimum_storage_bytes: INSTALLER_STORAGE_BYTES,
            recommended_storage_bytes: INSTALLER_STORAGE_BYTES,
        }
    }
}

pub static INSTALLERS: [HardwareInstaller; 2] = [
    HardwareInstaller {
        board: "green-installer",
        download_url: "https://github.com/NabuCasa/buildroot-installer/releases/download/green-installer-20240410/green-installer-20240410.img.xz",
        size: 38_254_492,
        digest: "sha256:bc2b72b518fab6b7bcbe8d5edcb1e1f55caae281b5c0856da8c939fa211a1422",
        extracted_size: 76_627_968,
    },
    HardwareInstaller {
        board: "yellow-installer",
        download_url: "https://github.com/NabuCasa/buildroot-installer/releases/download/yellow-installer-20231025/yellow-installer-20231025.img.xz",
        size: 33_371_388,
        digest: "sha256:fa1c4fdd72d116527cf37a1d3b849c480c08fff373b4a6c8d0017dae7da3e3f2",
        extracted_size: 68_157_440,
    },
];

/// The pinned installer for `board`, if it is an installer board.
pub fn find(board: &str) -> Option<&'static HardwareInstaller> {
    INSTALLERS.iter().find(|installer| installer.board == board)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installers_come_from_the_buildroot_installer_releases() {
        for installer in &INSTALLERS {
            let release = installer
                .download_url
                .strip_prefix("https://github.com/NabuCasa/buildroot-installer/releases/download/")
                .unwrap_or_else(|| panic!("{} is not a release asset", installer.board));
            let (tag, file) = release.split_once('/').unwrap();
            assert!(tag.starts_with(installer.board), "{tag}");
            assert_eq!(file, format!("{tag}.img.xz"));
        }
    }

    #[test]
    fn installer_digests_are_accepted_by_the_download_check() {
        for installer in &INSTALLERS {
            let expected = crate::download::expected_sha256(&installer.image()).unwrap();
            assert_eq!(
                installer.digest,
                format!("sha256:{}", hex::encode(expected)),
                "{}",
                installer.board
            );
        }
    }

    #[test]
    fn installer_sizes_fit_the_storage_minimum() {
        for installer in &INSTALLERS {
            let storage = installer.storage();
            assert!(installer.size > 1_000_000, "{}", installer.board);
            assert!(installer.extracted_size > installer.size);
            assert!(installer.extracted_size < storage.minimum_reported_storage_bytes());
            assert_eq!(
                storage.minimum_storage_bytes,
                storage.recommended_storage_bytes
            );
        }
    }

    #[test]
    fn installer_boards_are_unique_and_never_haos_boards() {
        let manifest = crate::manifest::bundled_manifest();
        for installer in &INSTALLERS {
            assert_eq!(find(installer.board).unwrap().digest, installer.digest);
            assert!(manifest
                .devices
                .iter()
                .all(|device| device.haos.board != installer.board));
        }
        assert!(find("green").is_none());
        assert!(find("odroid-n2").is_none());
    }

    #[test]
    fn installer_image_is_a_raw_image_with_a_digest() {
        let image = find("yellow-installer").unwrap().image();
        assert_eq!(image.format, ImageFormat::Raw);
        assert_eq!(image.size, 33_371_388);
        assert!(image.digest.is_some());
    }
}
