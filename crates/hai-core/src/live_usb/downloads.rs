//! Downloads and caches the official Alpine ISO and the HAOS image.
//!
//! Cache layout, inside the installer's cache folder:
//! `live-usb/alpine/<iso>` and `live-usb/haos/<version>/<image>.img.xz`.

use std::path::{Path, PathBuf};

use crate::download::{expected_sha256, file_matches, parse_version};
use crate::error::{Error, Result};
use crate::{HaosImage, ImageFormat, ProgressCallback, ReleaseSource};

/// Pinned Alpine release. Bumping it means updating the name, URL, checksum and size below.
pub const ALPINE_VERSION: &str = "3.24.2";
const ALPINE_ISO_NAME: &str = "alpine-standard-3.24.2-x86_64.iso";
const ALPINE_ISO_URL: &str =
    "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-standard-3.24.2-x86_64.iso";
/// From Alpine's published `.sha256` file for this ISO.
const ALPINE_ISO_SHA256: &str = "20c026e3a788bfb75fc8b50a54bcc12aee85e3c75909740bba6a6f4563d63296";
const ALPINE_ISO_SIZE: u64 = 370_147_328;

/// HAOS board name for generic x86-64 PCs.
pub const HAOS_BOARD: &str = "generic-x86-64";

/// A verified file in the cache.
#[derive(Debug, Clone)]
pub struct Download {
    /// Location in the cache.
    pub path: PathBuf,
    /// Release version, for example `3.24.2` or `17.1`.
    pub version: String,
    /// Lowercase hex SHA-256 of the file.
    pub sha256: String,
}

/// The live USB cache folder, created if missing.
pub fn cache_dir<B: ReleaseSource>(backend: &B) -> Result<PathBuf> {
    // A subfolder, so hai-desktop's startup cleanup (`prune_cached_images`) leaves it alone.
    let dir = backend.cache_dir()?.join("live-usb");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Returns the pinned Alpine ISO from `cache`, downloading and verifying it if needed.
pub async fn fetch_alpine<B: ReleaseSource, P: ProgressCallback>(
    backend: &B,
    cache: &Path,
    progress: &P,
) -> Result<Download> {
    // hai-core's downloader takes a HaosImage; it's only used here as "URL + size + digest".
    let image = HaosImage {
        board: "alpine".into(),
        format: ImageFormat::Raw,
        download_url: ALPINE_ISO_URL.into(),
        size: ALPINE_ISO_SIZE,
        digest: Some(format!("sha256:{ALPINE_ISO_SHA256}")),
    };
    let path = cache.join("alpine").join(ALPINE_ISO_NAME);
    fetch(backend, &image, &path, ALPINE_ISO_SHA256, progress).await?;
    Ok(Download {
        path,
        version: ALPINE_VERSION.into(),
        sha256: ALPINE_ISO_SHA256.into(),
    })
}

/// Returns the latest stable HAOS generic x86-64 image (still xz-compressed) from `cache`,
/// downloading and verifying it if needed. Needs network to look up the latest version.
pub async fn fetch_haos<B: ReleaseSource, P: ProgressCallback>(
    backend: &B,
    cache: &Path,
    progress: &P,
) -> Result<Download> {
    let release = backend
        .get_latest_haos_release_for_board(HAOS_BOARD)
        .await?;
    let version = release.version.clone();
    // The version becomes a folder name.
    if parse_version(&version).is_none() {
        return Err(Error::LiveUsbReleaseUnusable(format!(
            "unexpected version {version:?}"
        )));
    }
    let image = release
        .image_for(HAOS_BOARD, ImageFormat::Raw)
        .ok_or_else(|| {
            Error::LiveUsbReleaseUnusable(format!("{version} has no generic x86-64 image"))
        })?;
    let sha256 = expected_sha256(image).map(hex::encode).map_err(|_| {
        Error::LiveUsbReleaseUnusable(format!("{version} has no usable SHA-256 checksum"))
    })?;

    let path = cache
        .join("haos")
        .join(&version)
        .join(format!("haos_{HAOS_BOARD}-{version}.img.xz"));
    fetch(backend, image, &path, &sha256, progress).await?;
    Ok(Download {
        path,
        version,
        sha256,
    })
}

async fn fetch<B: ReleaseSource, P: ProgressCallback>(
    backend: &B,
    image: &HaosImage,
    path: &Path,
    sha256: &str,
    progress: &P,
) -> Result<()> {
    if file_matches(path, image.size, sha256, progress).await? {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Verifies size and SHA-256, and only moves the file into place once both match.
    backend.download_image(image, path, progress).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_versions_that_are_safe_folder_names_are_accepted() {
        for ok in ["17.1", "2026.10.0"] {
            assert!(parse_version(ok).is_some(), "{ok}");
        }
        for bad in [
            "", "16", "..", "../17.1", "17.1/..", "17.1-rc1", ".17", "17..1", "17.1\\x",
        ] {
            assert!(parse_version(bad).is_none(), "{bad}");
        }
    }
}
