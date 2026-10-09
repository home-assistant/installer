//! Downloads and caches the official Alpine ISO and the HAOS image.
//!
//! Cache layout, inside the installer's cache folder:
//! `live-usb/alpine/<iso>` and `live-usb/haos/<version>/<image>.img.xz`.

use std::fs::File;
use std::path::{Path, PathBuf};

use hai_core::{Backend, HaosImage, ImageFormat, ProgressCallback, ReleaseSource};
use sha2::{Digest, Sha256};

use crate::{Error, Result};

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

/// The `hai-usb` cache folder, created if missing.
pub fn cache_dir() -> Result<PathBuf> {
    // A subfolder, so hai-desktop's startup cleanup (`prune_cached_images`) leaves it alone.
    let dir = Backend.cache_dir()?.join("live-usb");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Returns the pinned Alpine ISO from `cache`, downloading and verifying it if needed.
pub async fn fetch_alpine<P: ProgressCallback>(cache: &Path, progress: &P) -> Result<Download> {
    // hai-core's downloader takes a HaosImage; it's only used here as "URL + size + digest".
    let image = HaosImage {
        board: "alpine".into(),
        format: ImageFormat::Raw,
        download_url: ALPINE_ISO_URL.into(),
        size: ALPINE_ISO_SIZE,
        digest: Some(format!("sha256:{ALPINE_ISO_SHA256}")),
    };
    let path = cache.join("alpine").join(ALPINE_ISO_NAME);
    fetch(&image, &path, ALPINE_ISO_SHA256, progress).await?;
    Ok(Download {
        path,
        version: ALPINE_VERSION.into(),
        sha256: ALPINE_ISO_SHA256.into(),
    })
}

/// Returns the latest stable HAOS generic x86-64 image (still xz-compressed) from `cache`,
/// downloading and verifying it if needed. Needs network to look up the latest version.
pub async fn fetch_haos<P: ProgressCallback>(cache: &Path, progress: &P) -> Result<Download> {
    let release = Backend
        .get_latest_haos_release_for_board(HAOS_BOARD)
        .await?;
    let version = release.version.clone();
    if !is_plain_version(&version) {
        return Err(Error::InvalidVersion(version));
    }
    let image = release
        .image_for(HAOS_BOARD, ImageFormat::Raw)
        .ok_or_else(|| Error::MissingImage(version.clone()))?;
    let sha256 = image
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .ok_or_else(|| Error::MissingChecksum(image.download_url.clone()))?
        .to_ascii_lowercase();

    let path = cache
        .join("haos")
        .join(&version)
        .join(format!("haos_{HAOS_BOARD}-{version}.img.xz"));
    fetch(image, &path, &sha256, progress).await?;
    Ok(Download {
        path,
        version,
        sha256,
    })
}

async fn fetch<P: ProgressCallback>(
    image: &HaosImage,
    path: &Path,
    sha256: &str,
    progress: &P,
) -> Result<()> {
    if is_cached(path, image.size, sha256).await? {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Verifies size and SHA-256, and only moves the file into place once both match.
    Backend.download_image(image, path, progress).await?;
    Ok(())
}

/// Whether `path` exists with exactly `size` bytes and the given SHA-256.
async fn is_cached(path: &Path, size: u64, sha256: &str) -> Result<bool> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() == size => {}
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    }
    let path = path.to_path_buf();
    let actual = tokio::task::spawn_blocking(move || sha256_of(&path))
        .await
        .map_err(std::io::Error::other)??;
    Ok(actual.eq_ignore_ascii_case(sha256))
}

fn sha256_of(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(hex::encode(hasher.finalize()));
        }
        hasher.update(&buffer[..read]);
    }
}

/// The version becomes a folder name, so only allow digits and dots.
fn is_plain_version(version: &str) -> bool {
    !version.is_empty()
        && version.bytes().all(|c| c.is_ascii_digit() || c == b'.')
        && !version.starts_with('.')
        && !version.contains("..")
}

#[cfg(test)]
mod tests {
    use super::*;

    const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    #[tokio::test]
    async fn cached_file_with_matching_size_and_hash_is_reused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, b"hello").unwrap();
        assert!(is_cached(&path, 5, HELLO_SHA256).await.unwrap());
        assert!(is_cached(&path, 5, &HELLO_SHA256.to_uppercase())
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn cached_file_is_not_reused_on_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, b"hellO").unwrap();
        assert!(
            !is_cached(&path, 5, HELLO_SHA256).await.unwrap(),
            "wrong hash"
        );
        assert!(
            !is_cached(&path, 6, HELLO_SHA256).await.unwrap(),
            "wrong size"
        );
        assert!(!is_cached(&dir.path().join("missing"), 5, HELLO_SHA256)
            .await
            .unwrap());
    }

    #[test]
    fn only_plain_versions_are_accepted() {
        for ok in ["17.1", "16", "2026.10.0"] {
            assert!(is_plain_version(ok), "{ok}");
        }
        for bad in [
            "", "..", "../17.1", "17.1/..", "17.1-rc1", ".17", "17..1", "17.1\\x",
        ] {
            assert!(!is_plain_version(bad), "{bad}");
        }
    }
}
