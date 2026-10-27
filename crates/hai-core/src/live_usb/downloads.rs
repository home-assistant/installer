//! Downloads and caches the official Alpine ISO and the HAOS image.
//!
//! Cache layout, inside the installer's cache folder:
//! `live-usb/alpine/<iso>` and `live-usb/haos/<version>/<image>.img.xz`.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::download::{expected_sha256, parse_version};
use crate::error::{Error, Result};
use crate::{FlashProgress, FlashStage, HaosImage, ImageFormat, ProgressCallback, ReleaseSource};

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

/// The live USB flow's folder inside the installer's cache folder.
pub(crate) const FOLDER: &str = "live-usb";

/// The live USB cache folder, created if missing.
pub fn cache_dir<B: ReleaseSource>(backend: &B) -> Result<PathBuf> {
    // A folder of its own, so `remove_cache` can take it away as a whole
    let dir = backend.cache_dir()?.join(FOLDER);
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
    if is_cached(path, image.size, sha256, progress).await? {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // What the other flows left goes before this build's own files
    let downloads = backend.cache_dir()?;
    let available = fs2::available_space(&downloads)?;
    crate::download::make_room(
        &downloads,
        Some(&downloads.join(FOLDER)),
        image.size,
        available,
    )?;
    // Verifies size and SHA-256, and only moves the file into place once both match.
    backend.download_image(image, path, progress).await?;
    Ok(())
}

/// Whether `path` exists with exactly `size` bytes and the given SHA-256.
async fn is_cached<P: ProgressCallback>(
    path: &Path,
    size: u64,
    sha256: &str,
    progress: &P,
) -> Result<bool> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() == size => {}
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    }
    let actual = sha256_with_progress(path, size, progress).await?;
    Ok(actual.eq_ignore_ascii_case(sha256))
}

/// Hashing a cached HAOS image takes several seconds, so it reports progress like a download
/// and stops with `Error::Cancelled` when asked to.
async fn sha256_with_progress<P: ProgressCallback>(
    path: &Path,
    size: u64,
    progress: &P,
) -> Result<String> {
    use tokio::io::AsyncReadExt;
    const REPORT_EVERY: u64 = 32 * 1024 * 1024;

    let report = |done: u64| {
        progress.on_progress(FlashProgress {
            stage: FlashStage::Downloading,
            progress: (done.saturating_mul(100) / size.max(1)).min(100) as u8,
            bytes_processed: done,
            total_bytes: size,
            message: "Checking the earlier download...".to_string(),
        });
    };
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    let (mut done, mut next_report) = (0u64, 0u64);
    loop {
        if progress.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if done >= next_report {
            report(done);
            next_report = done + REPORT_EVERY;
        }
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            report(done);
            return Ok(hex::encode(hasher.finalize()));
        }
        hasher.update(&buffer[..read]);
        done += read as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NoOpProgress;
    use std::sync::Mutex;

    const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    #[tokio::test]
    async fn cached_file_with_matching_size_and_hash_is_reused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, b"hello").unwrap();
        assert!(is_cached(&path, 5, HELLO_SHA256, &NoOpProgress)
            .await
            .unwrap());
        assert!(
            is_cached(&path, 5, &HELLO_SHA256.to_uppercase(), &NoOpProgress)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn cached_file_is_not_reused_on_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, b"hellO").unwrap();
        assert!(
            !is_cached(&path, 5, HELLO_SHA256, &NoOpProgress)
                .await
                .unwrap(),
            "wrong hash"
        );
        assert!(
            !is_cached(&path, 6, HELLO_SHA256, &NoOpProgress)
                .await
                .unwrap(),
            "wrong size"
        );
        assert!(
            !is_cached(&dir.path().join("missing"), 5, HELLO_SHA256, &NoOpProgress)
                .await
                .unwrap()
        );
    }

    struct Recorder(Mutex<Vec<(u64, u64)>>);

    impl ProgressCallback for Recorder {
        fn on_progress(&self, progress: FlashProgress) {
            let mut seen = self.0.lock().unwrap();
            seen.push((progress.bytes_processed, progress.total_bytes));
        }
    }

    #[tokio::test]
    async fn checking_a_cached_file_reports_progress_up_to_its_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, b"hello").unwrap();
        let recorder = Recorder(Mutex::new(Vec::new()));
        assert!(is_cached(&path, 5, HELLO_SHA256, &recorder).await.unwrap());
        let seen = recorder.0.into_inner().unwrap();
        assert_eq!(seen.first(), Some(&(0, 5)));
        assert_eq!(seen.last(), Some(&(5, 5)));
    }

    struct Cancelled;

    impl ProgressCallback for Cancelled {
        fn on_progress(&self, _: FlashProgress) {}

        fn is_cancelled(&self) -> bool {
            true
        }
    }

    #[tokio::test]
    async fn checking_a_cached_file_stops_when_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, b"hello").unwrap();
        let error = is_cached(&path, 5, HELLO_SHA256, &Cancelled)
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Cancelled), "{error:?}");
    }

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
