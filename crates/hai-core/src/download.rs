//! Image download and extraction functionality
//!
//! This module provides functions for downloading HAOS images,
//! verifying checksums, and extracting compressed archives.

use crate::error::{Error, Result};
use crate::types::{
    DeviceManifest, FlashProgress, FlashStage, GitHubRelease, HaosImage, HaosRelease, ImageFormat,
    StableVersionInfo,
};
use crate::ProgressCallback;
use directories::ProjectDirs;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::fs;

/// Home Assistant version API for stable releases
const VERSION_URL: &str = "https://version.home-assistant.io/stable.json";

/// GitHub API URL for HAOS releases
const HAOS_RELEASES_API: &str =
    "https://api.github.com/repos/home-assistant/operating-system/releases";

/// User agent for API requests
const USER_AGENT: &str = "HomeAssistantInstaller/0.1.0";

/// How often to send progress updates (every N bytes)
const PROGRESS_UPDATE_INTERVAL: u64 = 10 * 1024 * 1024; // 10 MB

/// Time allowed to establish a connection before giving up
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Total time allowed for the small JSON metadata requests
const API_TIMEOUT: Duration = Duration::from_secs(30);

/// Time allowed between two chunks of a download before giving up
///
/// This is deliberately not an overall timeout: a several-hundred-megabyte
/// image on a slow line may legitimately take a long time. It only bounds how
/// long a *stalled* connection is waited on, which otherwise hangs the
/// download stage forever.
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Suffix for downloads and extractions that are still in progress
///
/// [`cleanup_cache`] removes leftovers with this extension.
const PARTIAL_EXTENSION: &str = "part";

/// Headroom kept free on top of what an extraction is expected to need
const FREE_SPACE_MARGIN: u64 = 256 * 1024 * 1024; // 256 MB

/// Assumed compression ratio when an archive's uncompressed size is unreadable
///
/// HAOS raw images compress at roughly 6-7x (16.3's 2 GiB `rpi5-64` image
/// ships as a 332 MB archive). This is deliberately well above that: it only
/// applies when the archive index cannot be read, and over-estimating costs a
/// warning while under-estimating costs a full disk part-way through a write.
const XZ_FALLBACK_RATIO: u64 = 20;

/// Buffer size used when decompressing and when hashing files
const IO_BUFFER_SIZE: usize = 1024 * 1024; // 1 MB

/// Result of a successful extraction
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedImage {
    /// Path of the decompressed image
    pub path: PathBuf,
    /// Size of the decompressed image in bytes
    pub size: u64,
    /// SHA256 of the decompressed image, as computed while decoding
    pub sha256: String,
}

/// Build the HTTP client used for the small JSON metadata endpoints
///
/// The timeout is a parameter so tests can exercise the behaviour without
/// waiting out [`API_TIMEOUT`].
fn build_api_client(timeout: Duration) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .build()?)
}

fn api_client() -> Result<reqwest::Client> {
    build_api_client(API_TIMEOUT)
}

/// Build the HTTP client used for image downloads
///
/// The read timeout is a parameter so tests can exercise the stall handling
/// without waiting out [`DOWNLOAD_READ_TIMEOUT`].
fn build_download_client(read_timeout: Duration) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(read_timeout)
        .build()?)
}

fn download_client() -> Result<reqwest::Client> {
    build_download_client(DOWNLOAD_READ_TIMEOUT)
}

/// Path of the in-progress file for `path`
///
/// Appends `.part` rather than replacing the extension, so
/// `haos_green-16.3.img.xz` becomes `haos_green-16.3.img.xz.part`.
fn partial_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".");
    name.push(PARTIAL_EXTENSION);
    path.with_file_name(name)
}

/// Get the cache directory for downloaded images
pub fn get_cache_dir() -> Result<PathBuf> {
    let project_dirs = ProjectDirs::from("io", "home-assistant", "installer")
        .ok_or_else(|| Error::InvalidConfig("Could not determine cache directory".to_string()))?;

    let cache_dir = project_dirs.cache_dir().to_path_buf();
    std::fs::create_dir_all(&cache_dir)?;

    Ok(cache_dir)
}

/// Fetch the device manifest
///
/// In mock mode, returns mock data. Otherwise fetches from the network.
pub async fn get_device_manifest() -> Result<DeviceManifest> {
    #[cfg(feature = "mock")]
    {
        if crate::is_mock_enabled() {
            return Ok(crate::mock::get_mock_manifest());
        }
    }

    // For now, return the mock manifest as a fallback
    // TODO: Implement actual network fetch
    Ok(crate::mock::get_mock_manifest())
}

/// Check if cache should be skipped via environment variable
pub fn should_skip_cache() -> bool {
    std::env::var("HA_INSTALLER_NO_CACHE")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(false)
}

/// Get the path where an image would be cached
///
/// The filename comes from the download URL, so the raw and qcow2 builds of
/// one board - and the same board across releases - never share a cache entry.
pub fn get_cached_image_path(image: &HaosImage) -> Result<PathBuf> {
    let cache_dir = get_cache_dir()?;
    let fallback = format!("image{}", image.format.archive_suffix());
    let filename = image
        .download_url
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(&fallback);

    Ok(cache_dir.join(filename))
}

/// Check if an image is already cached and valid
///
/// Downloads land at their final name only after the whole body arrived and
/// its checksum matched (see [`download_image`]), so a file of the expected
/// size under that name is a complete, verified download.
pub async fn is_cached(image: &HaosImage) -> Result<bool> {
    // Allow skipping cache via environment variable
    if should_skip_cache() {
        return Ok(false);
    }

    let cache_path = get_cached_image_path(image)?;

    if !cache_path.exists() {
        return Ok(false);
    }

    // First check file size (fast)
    let metadata = fs::metadata(&cache_path).await?;
    if metadata.len() != image.size {
        return Ok(false);
    }

    // File size matches - for now, skip expensive SHA256 verification
    Ok(true)
}

/// Clean up old cached images (partial downloads)
pub async fn cleanup_cache() -> Result<()> {
    let cache_dir = get_cache_dir()?;

    if !cache_dir.exists() {
        return Ok(());
    }

    let mut entries = fs::read_dir(&cache_dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        // Remove partial downloads
        if path.extension().is_some_and(|ext| ext == PARTIAL_EXTENSION) {
            let _ = fs::remove_file(path).await;
        }
    }

    Ok(())
}

/// Compute SHA256 hash of a file
///
/// Reads the file in chunks: images are several gigabytes and must not be
/// pulled into memory in one piece.
pub async fn compute_file_sha256(path: &Path) -> Result<String> {
    let path = path.to_path_buf();

    tokio::task::spawn_blocking(move || {
        use std::io::Read;

        let mut file = std::fs::File::open(&path)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; IO_BUFFER_SIZE];

        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }

        Ok::<String, Error>(hex::encode(hasher.finalize()))
    })
    .await
    .map_err(|e| Error::VerificationFailed(e.to_string()))?
}

/// Bytes available to the current user on the filesystem holding `path`
///
/// Returns `None` when the figure cannot be determined, in which case callers
/// skip the check rather than block an otherwise valid install.
pub fn available_space(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;

        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };

        // SAFETY: `c_path` is a valid NUL-terminated string and `stat` is a
        // correctly sized, writable `statvfs` that outlives the call.
        if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
            return None;
        }

        // These fields are 32 bits wide on some platforms and 64 on others,
        // so widen through `Into` rather than a cast that would be redundant
        // on half of them.
        fn widen(value: impl Into<u64>) -> u64 {
            value.into()
        }

        // `f_frsize` is the fragment size blocks are counted in; some
        // filesystems leave it at 0 and only report `f_bsize`.
        let block_size = if stat.f_frsize > 0 {
            widen(stat.f_frsize)
        } else {
            widen(stat.f_bsize)
        };

        widen(stat.f_bavail).checked_mul(block_size)
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut free_for_caller: u64 = 0;

        // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the
        // call, `free_for_caller` is a writable `u64`, and the two figures we
        // do not need are passed as NULL, which the API documents as allowed.
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free_for_caller,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };

        (ok != 0).then_some(free_for_caller)
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        None
    }
}

/// Space an extraction needs, including headroom
///
/// `uncompressed_size` comes from the archive's index and is exact. When it
/// could not be read, the compressed size is scaled by [`XZ_FALLBACK_RATIO`]
/// instead - deliberately generous, since the cost of over-estimating is a
/// warning and the cost of under-estimating is a full disk mid-write.
fn required_space_for(compressed_size: u64, uncompressed_size: Option<u64>) -> u64 {
    uncompressed_size
        .unwrap_or_else(|| compressed_size.saturating_mul(XZ_FALLBACK_RATIO))
        .saturating_add(FREE_SPACE_MARGIN)
}

/// Fail if `dir` does not have `required_bytes` free
///
/// A no-op when the available space cannot be queried.
pub fn ensure_free_space(dir: &Path, required_bytes: u64) -> Result<()> {
    match available_space(dir) {
        Some(available_bytes) if available_bytes < required_bytes => {
            Err(Error::InsufficientDiskSpace {
                required_bytes,
                available_bytes,
            })
        }
        _ => Ok(()),
    }
}

/// Decode an xz multibyte integer (little-endian base-128)
///
/// Advances `pos` past the encoded value. Returns `None` for a truncated or
/// non-canonical encoding.
fn read_xz_varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut value: u64 = 0;

    for i in 0..9 {
        let byte = *buf.get(*pos)?;
        *pos += 1;
        value |= u64::from(byte & 0x7f) << (i * 7);

        if byte & 0x80 == 0 {
            // Only the first byte may be zero; a trailing zero byte means the
            // value was padded, which the format forbids.
            if i > 0 && byte == 0 {
                return None;
            }
            return Some(value);
        }
    }

    None
}

/// Total uncompressed size recorded in a single-stream `.xz` archive's index
///
/// `.xz` stores the uncompressed size of every block in an index at the end of
/// the file, so the figure is exact and costs two small reads rather than a
/// trial decompression.
///
/// Returns `None` when the file is not a single-stream `.xz` archive or the
/// index does not parse - including concatenated multi-stream archives, whose
/// trailing index describes only the final stream.
fn xz_uncompressed_size(path: &Path) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom};

    /// Stream header: magic (6) | stream flags (2) | CRC32 (4)
    const HEADER_SIZE: u64 = 12;
    /// Stream footer: CRC32 (4) | backward size (4) | stream flags (2) | "YZ"
    const FOOTER_SIZE: u64 = 12;

    let mut file = std::fs::File::open(path).ok()?;
    let file_size = file.metadata().ok()?.len();
    if file_size < HEADER_SIZE + FOOTER_SIZE {
        return None;
    }

    let mut footer = [0u8; FOOTER_SIZE as usize];
    file.seek(SeekFrom::Start(file_size - FOOTER_SIZE)).ok()?;
    file.read_exact(&mut footer).ok()?;
    if &footer[10..12] != b"YZ" {
        return None;
    }

    // Backward size is stored as (index size / 4) - 1
    let backward_size = u32::from_le_bytes([footer[4], footer[5], footer[6], footer[7]]);
    let index_size = (u64::from(backward_size) + 1) * 4;
    if index_size > file_size - HEADER_SIZE - FOOTER_SIZE {
        return None;
    }

    let mut index = vec![0u8; index_size as usize];
    file.seek(SeekFrom::Start(file_size - FOOTER_SIZE - index_size))
        .ok()?;
    file.read_exact(&mut index).ok()?;

    // Index: indicator (0x00) | record count | records | padding | CRC32
    let mut pos = 0usize;
    if *index.first()? != 0x00 {
        return None;
    }
    pos += 1;

    let record_count = read_xz_varint(&index, &mut pos)?;
    // Each record is at least two bytes, so a count beyond that is corrupt
    // (and would otherwise spin the loop below).
    if record_count > index_size / 2 {
        return None;
    }

    let mut uncompressed_total: u64 = 0;
    let mut blocks_total: u64 = 0;

    for _ in 0..record_count {
        let unpadded_size = read_xz_varint(&index, &mut pos)?;
        let uncompressed_size = read_xz_varint(&index, &mut pos)?;
        // Blocks are padded out to a multiple of four bytes
        blocks_total = blocks_total.checked_add(unpadded_size.checked_add(3)? & !3)?;
        uncompressed_total = uncompressed_total.checked_add(uncompressed_size)?;
    }

    // Everything in the file has to be accounted for; if it isn't, this is a
    // multi-stream or padded archive and the total above is only part of it.
    if HEADER_SIZE + blocks_total + index_size + FOOTER_SIZE != file_size {
        return None;
    }

    Some(uncompressed_total)
}

/// Fetch the stable version info from Home Assistant (internal version with custom URL)
async fn get_stable_version_from_url(url: &str) -> Result<StableVersionInfo> {
    let client = api_client()?;
    let response = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "Failed to fetch version info: HTTP {}",
            response.status()
        )));
    }

    let version_info: StableVersionInfo = response.json().await?;
    Ok(version_info)
}

/// Fetch the stable version info from Home Assistant
pub async fn get_stable_version() -> Result<StableVersionInfo> {
    #[cfg(feature = "mock")]
    {
        if crate::is_mock_enabled() {
            return Ok(crate::mock::get_mock_stable_version());
        }
    }

    get_stable_version_from_url(VERSION_URL).await
}

/// Get the latest stable HAOS version from the version API
pub async fn get_latest_haos_version() -> Result<String> {
    let version_info = get_stable_version().await?;

    // All boards should have the same version, just get the first one
    version_info
        .hassos
        .values()
        .next()
        .cloned()
        .ok_or_else(|| Error::DownloadFailed("No HAOS versions found in stable.json".to_string()))
}

/// Fetch the latest HAOS release information
pub async fn fetch_latest_release() -> Result<HaosRelease> {
    let version = get_latest_haos_version().await?;
    fetch_release(&version).await
}

/// Fetch a specific HAOS release by version (internal version with custom base URL)
async fn fetch_release_from_api(api_base_url: &str, version: &str) -> Result<HaosRelease> {
    let client = api_client()?;
    let response = client
        .get(format!("{}/tags/{}", api_base_url, version))
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "Failed to fetch release {}: HTTP {}",
            version,
            response.status()
        )));
    }

    let release: GitHubRelease = response.json().await?;
    parse_github_release(release)
}

/// Fetch a specific HAOS release by version
pub async fn fetch_release(version: &str) -> Result<HaosRelease> {
    #[cfg(feature = "mock")]
    {
        if crate::is_mock_enabled() {
            return Ok(crate::mock::get_mock_haos_release());
        }
    }

    fetch_release_from_api(HAOS_RELEASES_API, version).await
}

/// Fetch HAOS release info for a specific version (or "latest")
pub async fn get_haos_release(version: &str) -> Result<HaosRelease> {
    #[cfg(feature = "mock")]
    {
        if crate::is_mock_enabled() {
            return Ok(crate::mock::get_mock_haos_release());
        }
    }

    if version == "latest" {
        fetch_latest_release().await
    } else {
        fetch_release(version).await
    }
}

/// Parse a GitHub release into our HaosRelease format
fn parse_github_release(release: GitHubRelease) -> Result<HaosRelease> {
    let version = release.tag_name;
    let mut images = Vec::new();

    for asset in release.assets {
        // Process .img.xz and .qcow2.xz files
        let Some(format) = ImageFormat::from_asset_name(&asset.name) else {
            continue;
        };

        // Parse board name from filename: haos_{board}-{version}.img.xz
        let board = match parse_board_from_filename_with_suffix(
            &asset.name,
            &version,
            format.archive_suffix(),
        ) {
            Ok(b) => b,
            Err(_) => continue,
        };

        // Parse SHA256 from digest field
        let sha256 = asset
            .digest
            .and_then(|d| d.strip_prefix("sha256:").map(|s| s.to_string()))
            .unwrap_or_default();

        images.push(HaosImage {
            board,
            format,
            download_url: asset.browser_download_url,
            size: asset.size,
            sha256,
        });
    }

    Ok(HaosRelease { version, images })
}

/// Parse board name from HAOS image filename with a specific suffix
fn parse_board_from_filename_with_suffix(
    filename: &str,
    version: &str,
    file_suffix: &str,
) -> Result<String> {
    // Format: haos_{board}-{version}{file_suffix}
    let prefix = "haos_";
    let suffix = format!("-{}{}", version, file_suffix);

    if !filename.starts_with(prefix) || !filename.ends_with(&suffix) {
        return Err(Error::InvalidConfig(format!(
            "Invalid filename format: {}",
            filename
        )));
    }

    let board = filename
        .strip_prefix(prefix)
        .and_then(|s| s.strip_suffix(&suffix))
        .ok_or_else(|| Error::InvalidConfig(format!("Cannot parse board from: {}", filename)))?;

    Ok(board.to_string())
}

/// Parse board name from HAOS image filename (convenience wrapper for .img.xz)
pub fn parse_board_from_filename(filename: &str, version: &str) -> Result<String> {
    parse_board_from_filename_with_suffix(filename, version, ImageFormat::Raw.archive_suffix())
}

/// Find the image for a board in a release, in a specific format
///
/// The format is not optional on purpose. HAOS publishes some boards - notably
/// `generic-aarch64` - as both `.img.xz` and `.qcow2.xz`, and both parse to the
/// same board name. Matching on the board alone returns whichever GitHub
/// happens to list first, and a qcow2 written raw to a disk produces a machine
/// that does not boot without anything reporting an error.
pub fn find_image_for_board<'a>(
    release: &'a HaosRelease,
    board: &str,
    format: ImageFormat,
) -> Option<&'a HaosImage> {
    release
        .images
        .iter()
        .find(|img| img.board == board && img.format == format)
}

/// Download an image into the cache, reusing a complete cached copy
///
/// Returns the path of the compressed archive in the cache directory. Set
/// `HA_INSTALLER_NO_CACHE=1` to always re-download.
pub async fn fetch_image<P: ProgressCallback>(
    image: &HaosImage,
    progress_callback: &P,
) -> Result<PathBuf> {
    let cache_path = get_cached_image_path(image)?;

    if is_cached(image).await? {
        progress_callback.on_progress(FlashProgress {
            stage: FlashStage::Downloading,
            progress: 100,
            bytes_processed: image.size,
            total_bytes: image.size,
            message: "Using previously downloaded image".to_string(),
        });
        return Ok(cache_path);
    }

    download_image(
        &image.download_url,
        &cache_path,
        image.checksum(),
        progress_callback,
    )
    .await?;

    Ok(cache_path)
}

/// Download an image file with progress updates
///
/// The body is written to a `.part` file next to `dest_path` and renamed into
/// place only once the transfer finished and the checksum matched, so
/// `dest_path` never names a truncated or unverified file.
///
/// An empty `expected_sha256` is treated as absent: HAOS releases from before
/// GitHub published asset digests carry no checksum, and comparing against the
/// empty string would fail every one of them.
pub async fn download_image<P: ProgressCallback>(
    url: &str,
    dest_path: &PathBuf,
    expected_sha256: Option<&str>,
    progress_callback: &P,
) -> Result<()> {
    #[cfg(feature = "mock")]
    {
        if crate::is_mock_enabled() {
            // Simulate download progress
            for i in 0..=100 {
                progress_callback.on_progress(FlashProgress {
                    stage: FlashStage::Downloading,
                    progress: i,
                    bytes_processed: (i as u64) * 1_000_000,
                    total_bytes: 100_000_000,
                    message: "Downloading image (mock)...".to_string(),
                });
                tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
            }
            return Ok(());
        }
    }

    let expected_sha256 = expected_sha256.map(str::trim).filter(|s| !s.is_empty());
    let partial_path = partial_path(dest_path);

    let result = download_to_partial(url, &partial_path, expected_sha256, progress_callback).await;

    let downloaded = match result {
        Ok(downloaded) => downloaded,
        Err(e) => {
            let _ = std::fs::remove_file(&partial_path);
            return Err(e);
        }
    };

    // Only now does the final name appear, and it always names a complete,
    // checksum-verified file.
    std::fs::rename(&partial_path, dest_path)?;

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 100,
        bytes_processed: downloaded,
        total_bytes: downloaded,
        message: "Download complete".to_string(),
    });

    Ok(())
}

/// Stream `url` into `partial_path`, verifying the checksum
///
/// Returns the number of bytes written. The caller removes `partial_path` if
/// this fails.
async fn download_to_partial<P: ProgressCallback>(
    url: &str,
    partial_path: &Path,
    expected_sha256: Option<&str>,
    progress_callback: &P,
) -> Result<u64> {
    let client = download_client()?;
    let response = client.get(url).send().await?;

    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "HTTP {} for {}",
            response.status(),
            url
        )));
    }

    let total_size = response.content_length().unwrap_or(0);

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 0,
        bytes_processed: 0,
        total_bytes: total_size,
        message: "Starting download...".to_string(),
    });

    let mut file = std::fs::File::create(partial_path)?;
    let mut hasher = expected_sha256.map(|_| Sha256::new());
    let mut downloaded: u64 = 0;
    let mut last_progress_update: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;

        use std::io::Write;
        file.write_all(&chunk)?;

        if let Some(ref mut h) = hasher {
            h.update(&chunk);
        }

        downloaded += chunk.len() as u64;

        // Send progress update every PROGRESS_UPDATE_INTERVAL bytes
        if downloaded - last_progress_update >= PROGRESS_UPDATE_INTERVAL {
            let progress = if total_size > 0 {
                ((downloaded as f64 / total_size as f64) * 100.0) as u8
            } else {
                0
            };

            progress_callback.on_progress(FlashProgress {
                stage: FlashStage::Downloading,
                progress,
                bytes_processed: downloaded,
                total_bytes: total_size,
                message: "Downloading image...".to_string(),
            });
            last_progress_update = downloaded;
        }
    }

    file.sync_all()?;

    // Verify checksum if provided
    if let (Some(expected), Some(hasher)) = (expected_sha256, hasher) {
        let actual = hex::encode(hasher.finalize());
        if actual != expected {
            return Err(Error::ChecksumMismatch {
                expected: expected.to_string(),
                actual,
            });
        }
    }

    Ok(downloaded)
}

/// Extract a .xz compressed file
///
/// Before decompressing, the filesystem is checked for enough free space for
/// the decompressed image, whose exact size is read from the archive's own
/// index. The output goes to a `.part` file and is renamed into place only
/// after the whole stream decoded and the bytes on disk were accounted for, so
/// `dest_path` never names a half-extracted image.
pub async fn extract_xz<P: ProgressCallback>(
    archive_path: &Path,
    dest_path: &Path,
    progress_callback: &P,
) -> Result<ExtractedImage> {
    use std::sync::mpsc;

    #[cfg(feature = "mock")]
    {
        if crate::is_mock_enabled() {
            // Simulate extraction progress
            for i in 0..=100 {
                progress_callback.on_progress(FlashProgress {
                    stage: FlashStage::Extracting,
                    progress: i,
                    bytes_processed: (i as u64) * 5_000_000,
                    total_bytes: 500_000_000,
                    message: "Extracting image (mock)...".to_string(),
                });
                tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
            }
            // Nothing was written, so report the simulated size and no digest
            return Ok(ExtractedImage {
                path: dest_path.to_path_buf(),
                size: 500_000_000,
                sha256: String::new(),
            });
        }
    }

    let compressed_size = fs::metadata(archive_path).await?.len();

    // Exact when the archive index can be read, a deliberate over-estimate
    // otherwise - either way the point is to fail here with a clear message
    // rather than part-way through a multi-gigabyte write.
    let archive = archive_path.to_path_buf();
    let expected_size = tokio::task::spawn_blocking(move || xz_uncompressed_size(&archive))
        .await
        .map_err(|e| Error::ExtractionFailed(e.to_string()))?;

    ensure_free_space(
        dest_path.parent().unwrap_or_else(|| Path::new(".")),
        required_space_for(compressed_size, expected_size),
    )?;

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Extracting,
        progress: 0,
        bytes_processed: 0,
        total_bytes: expected_size.unwrap_or(0),
        message: "Extracting image...".to_string(),
    });

    // Create channel for progress updates
    let (progress_tx, progress_rx) = mpsc::channel::<u64>();

    let archive_path_clone = archive_path.to_path_buf();
    let partial = partial_path(dest_path);
    let partial_clone = partial.clone();

    let extract_handle = tokio::task::spawn_blocking(move || {
        use std::io::{Read, Write};

        let input = std::fs::File::open(&archive_path_clone)?;
        let mut decoder = xz2::read::XzDecoder::new(input);
        let mut output = std::fs::File::create(&partial_clone)?;

        let mut buffer = vec![0u8; IO_BUFFER_SIZE];
        let mut hasher = Sha256::new();
        let mut bytes_extracted: u64 = 0;
        let mut last_progress_update: u64 = 0;

        loop {
            let bytes_read = decoder.read(&mut buffer)?;
            if bytes_read == 0 {
                break;
            }
            output.write_all(&buffer[..bytes_read])?;
            hasher.update(&buffer[..bytes_read]);
            bytes_extracted += bytes_read as u64;

            // Send progress update every PROGRESS_UPDATE_INTERVAL bytes
            if bytes_extracted - last_progress_update >= PROGRESS_UPDATE_INTERVAL {
                let _ = progress_tx.send(bytes_extracted);
                last_progress_update = bytes_extracted;
            }
        }

        output.sync_all()?;
        let written = output.metadata()?.len();

        Ok::<(u64, u64, String), Error>((bytes_extracted, written, hex::encode(hasher.finalize())))
    });

    // Forward progress updates while waiting for extraction to complete
    loop {
        match progress_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(bytes_extracted) => {
                progress_callback.on_progress(FlashProgress {
                    // Without a known total this stays 0, which the UI reads
                    // as indeterminate.
                    progress: extraction_percentage(bytes_extracted, expected_size),
                    stage: FlashStage::Extracting,
                    bytes_processed: bytes_extracted,
                    total_bytes: expected_size.unwrap_or(0),
                    message: "Extracting image...".to_string(),
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if extract_handle.is_finished() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break;
            }
        }
    }

    let extraction = extract_handle
        .await
        .map_err(|e| Error::ExtractionFailed(e.to_string()))
        .and_then(|result| result);

    let (decoded_size, written_size, sha256) = match extraction {
        Ok(values) => values,
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            return Err(e);
        }
    };

    if let Err(e) = verify_extraction(decoded_size, written_size, expected_size) {
        let _ = std::fs::remove_file(&partial);
        return Err(e);
    }

    std::fs::rename(&partial, dest_path)?;

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Extracting,
        progress: 100,
        bytes_processed: decoded_size,
        total_bytes: decoded_size,
        message: "Extraction complete".to_string(),
    });

    Ok(ExtractedImage {
        path: dest_path.to_path_buf(),
        size: decoded_size,
        sha256,
    })
}

/// Percentage to report for an extraction that has produced `bytes_extracted`
///
/// Capped below 100 so the bar only reaches the end once the stream is
/// actually finished.
fn extraction_percentage(bytes_extracted: u64, expected_size: Option<u64>) -> u8 {
    match expected_size {
        Some(total) if total > 0 => {
            (((bytes_extracted as f64 / total as f64) * 100.0) as u64).min(99) as u8
        }
        _ => 0,
    }
}

/// Check that an extraction produced the image the archive promised
///
/// The `.xz` container already CRC-checks what it decodes; this covers the
/// other half - that every decoded byte reached the disk, and that the disk
/// holds exactly the image the archive index describes.
fn verify_extraction(
    decoded_size: u64,
    written_size: u64,
    expected_size: Option<u64>,
) -> Result<()> {
    if written_size != decoded_size {
        return Err(Error::ExtractionFailed(format!(
            "only {} of {} extracted bytes reached the disk - it may be full",
            written_size, decoded_size
        )));
    }

    if let Some(expected) = expected_size {
        if decoded_size != expected {
            return Err(Error::ExtractionFailed(format!(
                "extracted {} bytes but the archive declares {}",
                decoded_size, expected
            )));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::GitHubAsset;
    use serial_test::serial;

    #[test]
    fn test_get_cache_dir() {
        let result = get_cache_dir();
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_get_device_manifest_mock() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let manifest = get_device_manifest().await.unwrap();
        assert!(!manifest.devices.is_empty());
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[test]
    #[serial]
    fn test_should_skip_cache_true() {
        std::env::set_var("HA_INSTALLER_NO_CACHE", "1");
        assert!(should_skip_cache());
        std::env::remove_var("HA_INSTALLER_NO_CACHE");
    }

    #[test]
    #[serial]
    fn test_should_skip_cache_false() {
        std::env::remove_var("HA_INSTALLER_NO_CACHE");
        assert!(!should_skip_cache());
    }

    #[test]
    fn test_parse_board_from_filename_standard() {
        let result = parse_board_from_filename("haos_rpi5-64-14.2.img.xz", "14.2");
        assert_eq!(result.unwrap(), "rpi5-64");

        let result = parse_board_from_filename("haos_generic-x86-64-14.2.img.xz", "14.2");
        assert_eq!(result.unwrap(), "generic-x86-64");

        let result = parse_board_from_filename("haos_green-14.2.img.xz", "14.2");
        assert_eq!(result.unwrap(), "green");
    }

    #[test]
    fn test_parse_board_from_filename_qcow2() {
        let result = parse_board_from_filename_with_suffix(
            "haos_generic-x86-64-14.2.qcow2.xz",
            "14.2",
            ".qcow2.xz",
        );
        assert_eq!(result.unwrap(), "generic-x86-64");

        let result = parse_board_from_filename_with_suffix(
            "haos_generic-aarch64-14.2.qcow2.xz",
            "14.2",
            ".qcow2.xz",
        );
        assert_eq!(result.unwrap(), "generic-aarch64");
    }

    #[test]
    fn test_parse_board_from_filename_invalid() {
        // Wrong prefix
        let result = parse_board_from_filename("wrong_rpi5-64-14.2.img.xz", "14.2");
        assert!(result.is_err());

        // Wrong suffix
        let result = parse_board_from_filename("haos_rpi5-64-14.2.zip", "14.2");
        assert!(result.is_err());

        // Wrong version
        let result = parse_board_from_filename("haos_rpi5-64-14.2.img.xz", "14.3");
        assert!(result.is_err());
    }

    #[test]
    fn test_find_image_for_board_found() {
        let release = HaosRelease {
            version: "14.2".to_string(),
            images: vec![
                HaosImage {
                    format: ImageFormat::Raw,
                    board: "rpi5-64".to_string(),
                    download_url: "https://example.com/rpi5.img.xz".to_string(),
                    size: 100,
                    sha256: "abc".to_string(),
                },
                HaosImage {
                    format: ImageFormat::Raw,
                    board: "green".to_string(),
                    download_url: "https://example.com/green.img.xz".to_string(),
                    size: 200,
                    sha256: "def".to_string(),
                },
            ],
        };

        let found = find_image_for_board(&release, "green", ImageFormat::Raw);
        assert!(found.is_some());
        assert_eq!(found.unwrap().board, "green");
        assert_eq!(found.unwrap().size, 200);
    }

    #[test]
    fn test_find_image_for_board_not_found() {
        let release = HaosRelease {
            version: "14.2".to_string(),
            images: vec![HaosImage {
                format: ImageFormat::Raw,
                board: "rpi5-64".to_string(),
                download_url: "https://example.com/rpi5.img.xz".to_string(),
                size: 100,
                sha256: "abc".to_string(),
            }],
        };

        let found = find_image_for_board(&release, "nonexistent", ImageFormat::Raw);
        assert!(found.is_none());
    }

    #[test]
    fn test_parse_github_release() {
        let release = GitHubRelease {
            tag_name: "14.2".to_string(),
            assets: vec![
                GitHubAsset {
                    name: "haos_rpi5-64-14.2.img.xz".to_string(),
                    size: 500_000_000,
                    browser_download_url: "https://github.com/download/rpi5.img.xz".to_string(),
                    digest: Some("sha256:abc123".to_string()),
                },
                GitHubAsset {
                    name: "haos_generic-x86-64-14.2.qcow2.xz".to_string(),
                    size: 600_000_000,
                    browser_download_url: "https://github.com/download/x86.qcow2.xz".to_string(),
                    digest: Some("sha256:def456".to_string()),
                },
                // Should be ignored (wrong extension)
                GitHubAsset {
                    name: "haos_rpi5-64-14.2.img.xz.sha256".to_string(),
                    size: 100,
                    browser_download_url: "https://github.com/download/sha256".to_string(),
                    digest: None,
                },
            ],
        };

        let parsed = parse_github_release(release).unwrap();
        assert_eq!(parsed.version, "14.2");
        assert_eq!(parsed.images.len(), 2);

        // Check rpi5-64 image
        let rpi_image = parsed.images.iter().find(|i| i.board == "rpi5-64").unwrap();
        assert_eq!(rpi_image.size, 500_000_000);
        assert_eq!(rpi_image.sha256, "abc123");

        // Check x86 qcow2 image
        let x86_image = parsed
            .images
            .iter()
            .find(|i| i.board == "generic-x86-64")
            .unwrap();
        assert_eq!(x86_image.size, 600_000_000);
        assert_eq!(x86_image.sha256, "def456");
    }

    #[tokio::test]
    #[serial]
    async fn test_is_cached_skip_cache_env() {
        std::env::set_var("HA_INSTALLER_NO_CACHE", "1");
        let image = HaosImage {
            format: ImageFormat::Raw,
            board: "test".to_string(),
            download_url: "https://example.com/test.img.xz".to_string(),
            size: 100,
            sha256: "abc".to_string(),
        };
        let result = is_cached(&image).await.unwrap();
        assert!(!result);
        std::env::remove_var("HA_INSTALLER_NO_CACHE");
    }

    #[tokio::test]
    #[serial]
    async fn test_is_cached_file_not_exist() {
        std::env::remove_var("HA_INSTALLER_NO_CACHE");
        let image = HaosImage {
            format: ImageFormat::Raw,
            board: "test".to_string(),
            download_url: "https://example.com/nonexistent-file-12345.img.xz".to_string(),
            size: 100,
            sha256: "abc".to_string(),
        };
        let result = is_cached(&image).await.unwrap();
        assert!(!result);
    }

    #[tokio::test]
    async fn test_cleanup_cache_removes_part_files() {
        let cache_dir = get_cache_dir().unwrap();

        // Create a test .part file
        let part_file = cache_dir.join("test_cleanup.img.xz.part");
        std::fs::write(&part_file, b"test").unwrap();
        assert!(part_file.exists());

        // Run cleanup
        cleanup_cache().await.unwrap();

        // Part file should be removed
        assert!(!part_file.exists());
    }

    #[tokio::test]
    async fn test_get_cached_image_path() {
        let image = HaosImage {
            format: ImageFormat::Raw,
            board: "test".to_string(),
            download_url: "https://github.com/home-assistant/operating-system/releases/download/14.2/haos_rpi5-64-14.2.img.xz".to_string(),
            size: 100,
            sha256: "abc".to_string(),
        };

        let path = get_cached_image_path(&image).unwrap();
        assert!(path.to_string_lossy().contains("haos_rpi5-64-14.2.img.xz"));
    }

    #[tokio::test]
    #[serial]
    async fn test_get_haos_release_mock() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let release = get_haos_release("14.2").await.unwrap();
        assert!(!release.images.is_empty());
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[tokio::test]
    #[serial]
    async fn test_get_haos_release_latest_mock() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let release = get_haos_release("latest").await.unwrap();
        assert!(!release.images.is_empty());
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[test]
    fn test_parse_board_from_filename_empty() {
        let result = parse_board_from_filename("", "14.2");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_board_from_filename_no_haos_prefix() {
        let result = parse_board_from_filename("rpi5-64-14.2.img.xz", "14.2");
        assert!(result.is_err());
    }

    #[test]
    #[serial]
    fn test_should_skip_cache_true_lowercase() {
        std::env::set_var("HA_INSTALLER_NO_CACHE", "true");
        assert!(should_skip_cache());
        std::env::remove_var("HA_INSTALLER_NO_CACHE");
    }

    #[test]
    #[serial]
    fn test_should_skip_cache_false_with_false_value() {
        std::env::set_var("HA_INSTALLER_NO_CACHE", "false");
        assert!(!should_skip_cache());
        std::env::remove_var("HA_INSTALLER_NO_CACHE");
    }

    #[test]
    #[serial]
    fn test_should_skip_cache_false_with_zero() {
        std::env::set_var("HA_INSTALLER_NO_CACHE", "0");
        assert!(!should_skip_cache());
        std::env::remove_var("HA_INSTALLER_NO_CACHE");
    }

    #[test]
    fn test_get_cached_image_path_url_without_slash() {
        // Edge case: URL without "/" should use fallback filename
        let image = HaosImage {
            format: ImageFormat::Raw,
            board: "test".to_string(),
            download_url: "no-slashes-here".to_string(),
            size: 100,
            sha256: "abc".to_string(),
        };

        let path = get_cached_image_path(&image).unwrap();
        assert!(path.to_string_lossy().contains("no-slashes-here"));
    }

    #[tokio::test]
    #[serial]
    async fn test_is_cached_size_mismatch() {
        std::env::remove_var("HA_INSTALLER_NO_CACHE");

        // Create a temp file with wrong size
        let cache_dir = get_cache_dir().unwrap();
        let test_file = cache_dir.join("test_size_mismatch.img.xz");

        // Write 50 bytes
        std::fs::write(&test_file, &[0u8; 50]).unwrap();

        // Image expects 100 bytes
        let image = HaosImage {
            format: ImageFormat::Raw,
            board: "test".to_string(),
            download_url: format!(
                "https://example.com/{}",
                test_file.file_name().unwrap().to_string_lossy()
            ),
            size: 100,
            sha256: "abc".to_string(),
        };

        let result = is_cached(&image).await.unwrap();
        assert!(!result, "Should return false when file size doesn't match");

        // Cleanup
        let _ = std::fs::remove_file(&test_file);
    }

    #[tokio::test]
    async fn test_compute_file_sha256() {
        // Create a temp file with known content
        let cache_dir = get_cache_dir().unwrap();
        let test_file = cache_dir.join("test_sha256.txt");
        std::fs::write(&test_file, b"hello world").unwrap();

        let hash = compute_file_sha256(&test_file).await.unwrap();
        // SHA256 of "hello world" is known
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );

        std::fs::remove_file(&test_file).unwrap();
    }

    #[tokio::test]
    async fn test_compute_file_sha256_empty_file() {
        let cache_dir = get_cache_dir().unwrap();
        let test_file = cache_dir.join("test_sha256_empty.txt");
        std::fs::write(&test_file, b"").unwrap();

        let hash = compute_file_sha256(&test_file).await.unwrap();
        // SHA256 of empty string
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );

        std::fs::remove_file(&test_file).unwrap();
    }

    #[tokio::test]
    async fn test_compute_file_sha256_nonexistent_file() {
        let path = std::path::PathBuf::from("/nonexistent/file/path.txt");
        let result = compute_file_sha256(&path).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    #[serial]
    async fn test_download_image_mock_mode() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let cache_dir = get_cache_dir().unwrap();
        let dest = cache_dir.join("mock_download_test.img");

        let result = download_image(
            "https://example.com/test.img",
            &dest,
            None,
            &crate::NoOpProgress,
        )
        .await;

        assert!(result.is_ok());
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[tokio::test]
    #[serial]
    async fn test_extract_xz_mock_mode() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let cache_dir = get_cache_dir().unwrap();
        let archive = cache_dir.join("mock_archive.xz");
        let dest = cache_dir.join("mock_extracted.img");

        let result = extract_xz(&archive, &dest, &crate::NoOpProgress).await;
        assert!(result.is_ok());

        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[tokio::test]
    #[serial]
    async fn test_download_image_http_404_error() {
        std::env::remove_var("HA_INSTALLER_MOCK");

        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("GET", "/test.img.xz")
            .with_status(404)
            .create_async()
            .await;

        let url = format!("{}/test.img.xz", server.url());
        let cache_dir = get_cache_dir().unwrap();
        let dest = cache_dir.join("test_404.img");

        let result = download_image(&url, &dest, None, &crate::NoOpProgress).await;
        assert!(result.is_err());

        if let Err(e) = result {
            assert!(matches!(e, crate::error::Error::DownloadFailed(_)));
        }

        mock.assert_async().await;
        let _ = std::fs::remove_file(&dest);
    }

    #[tokio::test]
    #[serial]
    async fn test_download_image_http_500_error() {
        std::env::remove_var("HA_INSTALLER_MOCK");

        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("GET", "/test.img.xz")
            .with_status(500)
            .create_async()
            .await;

        let url = format!("{}/test.img.xz", server.url());
        let cache_dir = get_cache_dir().unwrap();
        let dest = cache_dir.join("test_500.img");

        // Clean up any existing file from previous test runs
        let _ = std::fs::remove_file(&dest);

        let result = download_image(&url, &dest, None, &crate::NoOpProgress).await;
        assert!(result.is_err());

        mock.assert_async().await;
        let _ = std::fs::remove_file(&dest);
    }

    #[tokio::test]
    #[serial]
    async fn test_download_image_success_without_checksum() {
        std::env::remove_var("HA_INSTALLER_MOCK");

        let mut server = mockito::Server::new_async().await;

        let test_data = b"test image data content";
        let mock = server
            .mock("GET", "/test.img.xz")
            .with_status(200)
            .with_header("content-length", &test_data.len().to_string())
            .with_body(test_data.as_slice())
            .create_async()
            .await;

        let url = format!("{}/test.img.xz", server.url());
        let cache_dir = get_cache_dir().unwrap();
        let dest = cache_dir.join("test_download_success.img");

        let result = download_image(&url, &dest, None, &crate::NoOpProgress).await;
        assert!(result.is_ok());

        // Verify file was created and has correct content
        let content = std::fs::read(&dest).unwrap();
        assert_eq!(content, test_data);

        mock.assert_async().await;
        std::fs::remove_file(&dest).unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn test_download_image_with_checksum_verification_success() {
        std::env::remove_var("HA_INSTALLER_MOCK");

        let mut server = mockito::Server::new_async().await;

        let test_data = b"test image data";
        // Pre-computed SHA256 of "test image data"
        let expected_sha = "fc50f1a3c9cbf0154d7dc87998446624c8b78f84c5cbef4f8139a0c8be1e4976";

        let mock = server
            .mock("GET", "/test.img.xz")
            .with_status(200)
            .with_header("content-length", &test_data.len().to_string())
            .with_body(test_data.as_slice())
            .create_async()
            .await;

        let url = format!("{}/test.img.xz", server.url());
        let cache_dir = get_cache_dir().unwrap();
        let dest = cache_dir.join("test_checksum_success.img");

        // Clean up any existing file from previous test runs
        let _ = std::fs::remove_file(&dest);

        let result = download_image(&url, &dest, Some(expected_sha), &crate::NoOpProgress).await;
        assert!(result.is_ok());

        mock.assert_async().await;
        std::fs::remove_file(&dest).unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn test_download_image_checksum_mismatch() {
        std::env::remove_var("HA_INSTALLER_MOCK");

        let mut server = mockito::Server::new_async().await;

        let test_data = b"test data";
        let wrong_sha = "0000000000000000000000000000000000000000000000000000000000000000";

        let mock = server
            .mock("GET", "/test.img.xz")
            .with_status(200)
            .with_header("content-length", &test_data.len().to_string())
            .with_body(test_data.as_slice())
            .create_async()
            .await;

        let url = format!("{}/test.img.xz", server.url());
        let cache_dir = get_cache_dir().unwrap();
        let dest = cache_dir.join("test_checksum_fail.img");

        let result = download_image(&url, &dest, Some(wrong_sha), &crate::NoOpProgress).await;
        assert!(result.is_err());

        if let Err(e) = result {
            assert!(matches!(e, crate::error::Error::ChecksumMismatch { .. }));
        }

        // File should be deleted on checksum failure
        assert!(!dest.exists());

        mock.assert_async().await;
    }

    #[tokio::test]
    #[serial]
    async fn test_download_image_with_progress_updates() {
        std::env::remove_var("HA_INSTALLER_MOCK");

        use std::sync::{Arc, Mutex};

        struct TestProgressCallback {
            calls: Arc<Mutex<Vec<FlashProgress>>>,
        }

        impl crate::ProgressCallback for TestProgressCallback {
            fn on_progress(&self, progress: FlashProgress) {
                self.calls.lock().unwrap().push(progress);
            }
        }

        let mut server = mockito::Server::new_async().await;

        // Create data larger than PROGRESS_UPDATE_INTERVAL (10MB)
        let test_data = vec![0u8; 11 * 1024 * 1024]; // 11MB

        let mock = server
            .mock("GET", "/large.img.xz")
            .with_status(200)
            .with_header("content-length", &test_data.len().to_string())
            .with_body(&test_data)
            .create_async()
            .await;

        let url = format!("{}/large.img.xz", server.url());
        let cache_dir = get_cache_dir().unwrap();
        let dest = cache_dir.join("test_progress.img");

        let calls = Arc::new(Mutex::new(Vec::new()));
        let callback = TestProgressCallback {
            calls: calls.clone(),
        };

        let result = download_image(&url, &dest, None, &callback).await;
        assert!(result.is_ok());

        // Check that we got progress callbacks
        let progress_calls = calls.lock().unwrap();
        assert!(!progress_calls.is_empty());
        assert!(progress_calls.iter().any(|p| p.progress == 0)); // Start
        assert!(progress_calls.iter().any(|p| p.progress == 100)); // End
        assert!(progress_calls
            .iter()
            .all(|p| p.stage == FlashStage::Downloading));

        mock.assert_async().await;
        std::fs::remove_file(&dest).unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn test_download_image_no_content_length() {
        std::env::remove_var("HA_INSTALLER_MOCK");

        let mut server = mockito::Server::new_async().await;

        let test_data = b"small data";
        let mock = server
            .mock("GET", "/test.img.xz")
            .with_status(200)
            // No content-length header
            .with_body(test_data.as_slice())
            .create_async()
            .await;

        let url = format!("{}/test.img.xz", server.url());
        let cache_dir = get_cache_dir().unwrap();
        let dest = cache_dir.join("test_no_length.img");

        let result = download_image(&url, &dest, None, &crate::NoOpProgress).await;
        assert!(result.is_ok());

        mock.assert_async().await;
        std::fs::remove_file(&dest).unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn test_extract_xz_real_file() {
        std::env::remove_var("HA_INSTALLER_MOCK");

        use std::io::Write;

        let cache_dir = get_cache_dir().unwrap();
        let test_content = b"Hello, this is test content for XZ compression!";
        let extracted_path = cache_dir.join("test_extracted.txt");
        let archive_path = cache_dir.join("test_archive.txt.xz");

        // Create a real XZ compressed file
        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let mut encoder = xz2::write::XzEncoder::new(file, 6);
            encoder.write_all(test_content).unwrap();
            encoder.finish().unwrap();
        }

        // Extract it
        let result = extract_xz(&archive_path, &extracted_path, &crate::NoOpProgress).await;
        assert!(result.is_ok());

        // Verify extracted content
        let extracted = std::fs::read(&extracted_path).unwrap();
        assert_eq!(extracted, test_content);

        // Cleanup
        std::fs::remove_file(&archive_path).unwrap();
        std::fs::remove_file(&extracted_path).unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn test_extract_xz_nonexistent_file() {
        std::env::remove_var("HA_INSTALLER_MOCK");

        let cache_dir = get_cache_dir().unwrap();
        let archive_path = cache_dir.join("nonexistent_archive.xz");
        let dest_path = cache_dir.join("output.img");

        let result = extract_xz(&archive_path, &dest_path, &crate::NoOpProgress).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    #[serial]
    async fn test_extract_xz_with_progress() {
        std::env::remove_var("HA_INSTALLER_MOCK");

        use std::io::Write;
        use std::sync::{Arc, Mutex};

        struct TestProgressCallback {
            calls: Arc<Mutex<Vec<FlashProgress>>>,
        }

        impl crate::ProgressCallback for TestProgressCallback {
            fn on_progress(&self, progress: FlashProgress) {
                self.calls.lock().unwrap().push(progress);
            }
        }

        let cache_dir = get_cache_dir().unwrap();
        // Create larger content to trigger progress updates (> 10MB)
        let test_content = vec![0u8; 11 * 1024 * 1024]; // 11MB
        let extracted_path = cache_dir.join("test_extracted_large.img");
        let archive_path = cache_dir.join("test_archive_large.img.xz");

        // Create XZ compressed file
        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let mut encoder = xz2::write::XzEncoder::new(file, 1); // Use compression level 1 for speed
            encoder.write_all(&test_content).unwrap();
            encoder.finish().unwrap();
        }

        let calls = Arc::new(Mutex::new(Vec::new()));
        let callback = TestProgressCallback {
            calls: calls.clone(),
        };

        // Extract with progress tracking
        let result = extract_xz(&archive_path, &extracted_path, &callback).await;
        assert!(result.is_ok());

        // Verify we got progress callbacks
        let progress_calls = calls.lock().unwrap();
        assert!(!progress_calls.is_empty());
        assert!(progress_calls.iter().any(|p| p.progress == 0)); // Start
        assert!(progress_calls.iter().any(|p| p.progress == 100)); // End
        assert!(progress_calls
            .iter()
            .all(|p| p.stage == FlashStage::Extracting));

        // Cleanup
        std::fs::remove_file(&archive_path).unwrap();
        std::fs::remove_file(&extracted_path).unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn test_is_cached_with_matching_size() {
        std::env::remove_var("HA_INSTALLER_NO_CACHE");

        let cache_dir = get_cache_dir().unwrap();
        let test_file = cache_dir.join("test_matching_size.img.xz");

        // Write exactly 100 bytes
        std::fs::write(&test_file, &[0u8; 100]).unwrap();

        // Image expects exactly 100 bytes
        let image = HaosImage {
            format: ImageFormat::Raw,
            board: "test".to_string(),
            download_url: format!(
                "https://example.com/{}",
                test_file.file_name().unwrap().to_string_lossy()
            ),
            size: 100,
            sha256: "abc".to_string(),
        };

        let result = is_cached(&image).await.unwrap();
        assert!(result, "Should return true when file size matches");

        // Cleanup
        std::fs::remove_file(&test_file).unwrap();
    }

    #[tokio::test]
    async fn test_cleanup_cache_nonexistent_directory() {
        // This tests the early return path when the cache directory doesn't exist
        // The function should handle this gracefully
        let result = cleanup_cache().await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_parse_github_release_with_missing_digest() {
        use crate::types::{GitHubAsset, GitHubRelease};

        let release = GitHubRelease {
            tag_name: "14.2".to_string(),
            assets: vec![GitHubAsset {
                name: "haos_rpi4-14.2.img.xz".to_string(),
                size: 500_000_000,
                browser_download_url: "https://github.com/download/rpi4.img.xz".to_string(),
                digest: None, // No digest
            }],
        };

        let parsed = parse_github_release(release).unwrap();
        assert_eq!(parsed.images.len(), 1);
        assert_eq!(parsed.images[0].sha256, ""); // Should be empty string
    }

    #[tokio::test]
    async fn test_parse_github_release_with_digest_no_prefix() {
        use crate::types::{GitHubAsset, GitHubRelease};

        let release = GitHubRelease {
            tag_name: "14.2".to_string(),
            assets: vec![GitHubAsset {
                name: "haos_rpi4-14.2.img.xz".to_string(),
                size: 500_000_000,
                browser_download_url: "https://github.com/download/rpi4.img.xz".to_string(),
                digest: Some("abc123".to_string()), // No "sha256:" prefix
            }],
        };

        let parsed = parse_github_release(release).unwrap();
        assert_eq!(parsed.images.len(), 1);
        assert_eq!(parsed.images[0].sha256, ""); // Should be empty when prefix missing
    }

    #[tokio::test]
    async fn test_parse_github_release_invalid_filename_skipped() {
        use crate::types::{GitHubAsset, GitHubRelease};

        let release = GitHubRelease {
            tag_name: "14.2".to_string(),
            assets: vec![GitHubAsset {
                name: "invalid_filename.img.xz".to_string(), // Doesn't match pattern
                size: 500_000_000,
                browser_download_url: "https://github.com/download/invalid.img.xz".to_string(),
                digest: Some("sha256:abc".to_string()),
            }],
        };

        let parsed = parse_github_release(release).unwrap();
        assert_eq!(parsed.images.len(), 0); // Invalid filename should be skipped
    }

    #[tokio::test]
    async fn test_parse_board_from_filename_with_suffix_error() {
        // Test the error path in parse_board_from_filename_with_suffix
        let result = parse_board_from_filename_with_suffix(
            "haos_rpi4-14.2.img.xz",
            "99.9", // Wrong version
            ".img.xz",
        );
        assert!(result.is_err());

        if let Err(e) = result {
            assert!(matches!(e, crate::error::Error::InvalidConfig(_)));
        }
    }

    #[tokio::test]
    async fn test_fetch_release_network_error() {
        let mut server = mockito::Server::new_async().await;

        let _mock = server
            .mock("GET", "/tags/14.2")
            .with_status(404)
            .create_async()
            .await;

        // Can't easily test this without dependency injection
        // This test documents the intent
    }

    #[tokio::test]
    async fn test_get_device_manifest_fallback() {
        // Without mock mode, should return mock manifest as fallback
        std::env::remove_var("HA_INSTALLER_MOCK");
        let manifest = get_device_manifest().await.unwrap();
        assert!(!manifest.devices.is_empty());
    }

    // HTTP Mock Tests Module
    // These tests use mockito to mock external HTTP endpoints
    mod http_mock_tests {
        use super::*;

        #[tokio::test]
        #[serial]
        async fn test_get_stable_version_success() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/stable.json")
                .match_header("User-Agent", "HomeAssistantInstaller/0.1.0")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"hassos":{"rpi4":"14.2","generic-x86-64":"14.2"}}"#)
                .create_async()
                .await;

            let url = format!("{}/stable.json", server.url());
            let result = get_stable_version_from_url(&url).await;
            assert!(result.is_ok());

            let version_info = result.unwrap();
            assert_eq!(version_info.hassos.get("rpi4"), Some(&"14.2".to_string()));
            assert_eq!(
                version_info.hassos.get("generic-x86-64"),
                Some(&"14.2".to_string())
            );

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_get_stable_version_http_404() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/stable.json")
                .with_status(404)
                .create_async()
                .await;

            let url = format!("{}/stable.json", server.url());
            let result = get_stable_version_from_url(&url).await;
            assert!(result.is_err());

            if let Err(e) = result {
                assert!(matches!(e, crate::error::Error::DownloadFailed(_)));
            }

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_get_stable_version_http_500() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/stable.json")
                .with_status(500)
                .create_async()
                .await;

            let url = format!("{}/stable.json", server.url());
            let result = get_stable_version_from_url(&url).await;
            assert!(result.is_err());

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_get_stable_version_invalid_json() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/stable.json")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body("not valid json")
                .create_async()
                .await;

            let url = format!("{}/stable.json", server.url());
            let result = get_stable_version_from_url(&url).await;
            assert!(result.is_err());

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_get_stable_version_empty_response() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/stable.json")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body("")
                .create_async()
                .await;

            let url = format!("{}/stable.json", server.url());
            let result = get_stable_version_from_url(&url).await;
            assert!(result.is_err());

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_get_stable_version_malformed_json() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/stable.json")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"hassos":{"rpi4":"14.2"}}"#) // Missing expected fields, but valid JSON
                .create_async()
                .await;

            let url = format!("{}/stable.json", server.url());
            let result = get_stable_version_from_url(&url).await;
            // This should succeed since the JSON is valid, even if minimal
            assert!(result.is_ok());

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_release_success() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/tags/14.2")
                .match_header("User-Agent", "HomeAssistantInstaller/0.1.0")
                .match_header("Accept", "application/vnd.github.v3+json")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                    "tag_name": "14.2",
                    "assets": [
                        {
                            "name": "haos_rpi5-64-14.2.img.xz",
                            "size": 500000000,
                            "browser_download_url": "https://github.com/download/rpi5.img.xz",
                            "digest": "sha256:abc123"
                        },
                        {
                            "name": "haos_generic-x86-64-14.2.qcow2.xz",
                            "size": 600000000,
                            "browser_download_url": "https://github.com/download/x86.qcow2.xz",
                            "digest": "sha256:def456"
                        }
                    ]
                }"#,
                )
                .create_async()
                .await;

            let result = fetch_release_from_api(&server.url(), "14.2").await;
            assert!(result.is_ok());

            let release = result.unwrap();
            assert_eq!(release.version, "14.2");
            assert_eq!(release.images.len(), 2);
            assert!(release.images.iter().any(|i| i.board == "rpi5-64"));
            assert!(release.images.iter().any(|i| i.board == "generic-x86-64"));

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_release_http_404() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/tags/99.99")
                .with_status(404)
                .create_async()
                .await;

            let result = fetch_release_from_api(&server.url(), "99.99").await;
            assert!(result.is_err());

            if let Err(e) = result {
                assert!(matches!(e, crate::error::Error::DownloadFailed(_)));
                let error_msg = format!("{:?}", e);
                assert!(error_msg.contains("404"));
            }

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_release_http_500() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/tags/14.2")
                .with_status(500)
                .create_async()
                .await;

            let result = fetch_release_from_api(&server.url(), "14.2").await;
            assert!(result.is_err());

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_release_invalid_json() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/tags/14.2")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body("invalid json")
                .create_async()
                .await;

            let result = fetch_release_from_api(&server.url(), "14.2").await;
            assert!(result.is_err());

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_release_empty_assets() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/tags/14.2")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                    "tag_name": "14.2",
                    "assets": []
                }"#,
                )
                .create_async()
                .await;

            let result = fetch_release_from_api(&server.url(), "14.2").await;
            assert!(result.is_ok());

            let release = result.unwrap();
            assert_eq!(release.version, "14.2");
            assert_eq!(release.images.len(), 0);

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_release_mixed_assets() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/tags/14.2")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                    "tag_name": "14.2",
                    "assets": [
                        {
                            "name": "haos_rpi5-64-14.2.img.xz",
                            "size": 500000000,
                            "browser_download_url": "https://github.com/download/rpi5.img.xz",
                            "digest": "sha256:abc123"
                        },
                        {
                            "name": "haos_rpi5-64-14.2.img.xz.sha256",
                            "size": 100,
                            "browser_download_url": "https://github.com/download/sha256",
                            "digest": null
                        },
                        {
                            "name": "README.md",
                            "size": 1000,
                            "browser_download_url": "https://github.com/download/readme",
                            "digest": null
                        }
                    ]
                }"#,
                )
                .create_async()
                .await;

            let result = fetch_release_from_api(&server.url(), "14.2").await;
            assert!(result.is_ok());

            let release = result.unwrap();
            assert_eq!(release.version, "14.2");
            assert_eq!(release.images.len(), 1); // Only valid image files
            assert_eq!(release.images[0].board, "rpi5-64");

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_release_with_redirects() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/tags/14.2")
                .with_status(302)
                .with_header("Location", "/redirected/tags/14.2")
                .create_async()
                .await;

            let redirect_mock = server
                .mock("GET", "/redirected/tags/14.2")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                    "tag_name": "14.2",
                    "assets": [{
                        "name": "haos_rpi4-14.2.img.xz",
                        "size": 400000000,
                        "browser_download_url": "https://github.com/download/rpi4.img.xz",
                        "digest": "sha256:xyz789"
                    }]
                }"#,
                )
                .create_async()
                .await;

            // reqwest follows redirects by default
            let result = fetch_release_from_api(&server.url(), "14.2").await;
            assert!(result.is_ok());

            let release = result.unwrap();
            assert_eq!(release.version, "14.2");
            assert_eq!(release.images.len(), 1);

            mock.assert_async().await;
            redirect_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_release_missing_digest() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/tags/14.2")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                    "tag_name": "14.2",
                    "assets": [{
                        "name": "haos_rpi4-14.2.img.xz",
                        "size": 400000000,
                        "browser_download_url": "https://github.com/download/rpi4.img.xz",
                        "digest": null
                    }]
                }"#,
                )
                .create_async()
                .await;

            let result = fetch_release_from_api(&server.url(), "14.2").await;
            assert!(result.is_ok());

            let release = result.unwrap();
            assert_eq!(release.images.len(), 1);
            assert_eq!(release.images[0].sha256, ""); // Should be empty when digest is null

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_release_digest_without_prefix() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/tags/14.2")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                    "tag_name": "14.2",
                    "assets": [{
                        "name": "haos_rpi4-14.2.img.xz",
                        "size": 400000000,
                        "browser_download_url": "https://github.com/download/rpi4.img.xz",
                        "digest": "abc123"
                    }]
                }"#,
                )
                .create_async()
                .await;

            let result = fetch_release_from_api(&server.url(), "14.2").await;
            assert!(result.is_ok());

            let release = result.unwrap();
            assert_eq!(release.images.len(), 1);
            assert_eq!(release.images[0].sha256, ""); // Should be empty when sha256: prefix is missing

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_download_image_network_timeout() {
            std::env::remove_var("HA_INSTALLER_MOCK");

            // Test with an invalid URL that will cause a network error
            let cache_dir = get_cache_dir().unwrap();
            let dest = cache_dir.join("test_timeout.img");

            let result = download_image(
                "http://192.0.2.1:9999/nonexistent", // Using TEST-NET-1 IP that should timeout
                &dest,
                None,
                &crate::NoOpProgress,
            )
            .await;

            assert!(result.is_err());
            let _ = std::fs::remove_file(&dest);
        }

        #[tokio::test]
        #[serial]
        async fn test_download_image_empty_response() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/empty.img.xz")
                .with_status(200)
                .with_header("content-length", "0")
                .with_body("")
                .create_async()
                .await;

            let url = format!("{}/empty.img.xz", server.url());
            let cache_dir = get_cache_dir().unwrap();
            let dest = cache_dir.join("test_empty.img");

            let result = download_image(&url, &dest, None, &crate::NoOpProgress).await;
            assert!(result.is_ok());

            // Verify empty file was created
            let metadata = std::fs::metadata(&dest).unwrap();
            assert_eq!(metadata.len(), 0);

            mock.assert_async().await;
            std::fs::remove_file(&dest).unwrap();
        }

        #[tokio::test]
        #[serial]
        async fn test_download_image_with_redirect() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let redirect_mock = server
                .mock("GET", "/redirect.img.xz")
                .with_status(302)
                .with_header("Location", "/actual.img.xz")
                .create_async()
                .await;

            let test_data = b"redirected content";
            let actual_mock = server
                .mock("GET", "/actual.img.xz")
                .with_status(200)
                .with_header("content-length", &test_data.len().to_string())
                .with_body(test_data.as_slice())
                .create_async()
                .await;

            let url = format!("{}/redirect.img.xz", server.url());
            let cache_dir = get_cache_dir().unwrap();
            let dest = cache_dir.join("test_redirect.img");

            let result = download_image(&url, &dest, None, &crate::NoOpProgress).await;
            assert!(result.is_ok());

            // Verify file content
            let content = std::fs::read(&dest).unwrap();
            assert_eq!(content, test_data);

            redirect_mock.assert_async().await;
            actual_mock.assert_async().await;
            std::fs::remove_file(&dest).unwrap();
        }

        #[tokio::test]
        #[serial]
        async fn test_get_stable_version_with_extra_fields() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/stable.json")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                    "hassos": {
                        "rpi4": "14.2",
                        "generic-x86-64": "14.2",
                        "green": "14.2",
                        "yellow": "14.2"
                    },
                    "extra_field": "should be ignored"
                }"#,
                )
                .create_async()
                .await;

            let url = format!("{}/stable.json", server.url());
            let result = get_stable_version_from_url(&url).await;
            assert!(result.is_ok());

            let version_info = result.unwrap();
            assert_eq!(version_info.hassos.len(), 4);
            assert_eq!(version_info.hassos.get("green"), Some(&"14.2".to_string()));

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_release_with_qcow2_only() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/tags/14.2")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                    "tag_name": "14.2",
                    "assets": [
                        {
                            "name": "haos_generic-x86-64-14.2.qcow2.xz",
                            "size": 600000000,
                            "browser_download_url": "https://github.com/download/x86.qcow2.xz",
                            "digest": "sha256:qcow2hash"
                        }
                    ]
                }"#,
                )
                .create_async()
                .await;

            let result = fetch_release_from_api(&server.url(), "14.2").await;
            assert!(result.is_ok());

            let release = result.unwrap();
            assert_eq!(release.images.len(), 1);
            assert_eq!(release.images[0].board, "generic-x86-64");
            assert!(release.images[0].download_url.contains("qcow2"));

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_release_connection_refused() {
            std::env::remove_var("HA_INSTALLER_MOCK");

            // Use a port that's likely not in use
            let result = fetch_release_from_api("http://127.0.0.1:59999", "14.2").await;
            assert!(result.is_err());
        }

        #[tokio::test]
        #[serial]
        async fn test_get_stable_version_connection_refused() {
            std::env::remove_var("HA_INSTALLER_MOCK");

            let result = get_stable_version_from_url("http://127.0.0.1:59998/stable.json").await;
            assert!(result.is_err());
        }
    }

    /// Tests for picking the right image format (F5), verifying what was
    /// downloaded and unpacked (F16), and surviving a bad download (F17).
    mod image_selection_and_integrity {
        use super::*;

        /// Release fixture where one board ships in both formats, qcow2 first
        fn dual_format_release() -> HaosRelease {
            HaosRelease {
                version: "16.3".to_string(),
                images: vec![
                    HaosImage {
                        board: "generic-aarch64".to_string(),
                        format: ImageFormat::Qcow2,
                        download_url: "https://example.com/haos_generic-aarch64-16.3.qcow2.xz"
                            .to_string(),
                        size: 339_480_672,
                        sha256: "qcow2sha".to_string(),
                    },
                    HaosImage {
                        board: "generic-aarch64".to_string(),
                        format: ImageFormat::Raw,
                        download_url: "https://example.com/haos_generic-aarch64-16.3.img.xz"
                            .to_string(),
                        size: 341_537_340,
                        sha256: "rawsha".to_string(),
                    },
                    HaosImage {
                        board: "generic-x86-64".to_string(),
                        format: ImageFormat::Raw,
                        download_url: "https://example.com/haos_generic-x86-64-16.3.img.xz"
                            .to_string(),
                        size: 396_451_208,
                        sha256: "x86sha".to_string(),
                    },
                ],
            }
        }

        #[test]
        fn test_image_format_from_asset_name() {
            assert_eq!(
                ImageFormat::from_asset_name("haos_rpi5-64-16.3.img.xz"),
                Some(ImageFormat::Raw)
            );
            assert_eq!(
                ImageFormat::from_asset_name("haos_ova-16.3.qcow2.xz"),
                Some(ImageFormat::Qcow2)
            );
            // Everything else in a HAOS release is not a disk image
            assert_eq!(ImageFormat::from_asset_name("haos_ova-16.3.raucb"), None);
            assert_eq!(ImageFormat::from_asset_name("haos_ova-16.3.vmdk.zip"), None);
            assert_eq!(
                ImageFormat::from_asset_name("haos_rpi5-64-16.3.img.xz.sha256"),
                None
            );
        }

        #[test]
        fn test_image_format_suffixes() {
            assert_eq!(ImageFormat::Raw.archive_suffix(), ".img.xz");
            assert_eq!(ImageFormat::Raw.image_suffix(), ".img");
            assert_eq!(ImageFormat::Qcow2.archive_suffix(), ".qcow2.xz");
            assert_eq!(ImageFormat::Qcow2.image_suffix(), ".qcow2");
        }

        /// The regression behind F5: both builds of a board parse to the same
        /// board name, so they have to be told apart by format.
        #[test]
        fn test_parse_github_release_keeps_both_formats_of_one_board() {
            let release = GitHubRelease {
                tag_name: "16.3".to_string(),
                assets: vec![
                    GitHubAsset {
                        name: "haos_generic-aarch64-16.3.qcow2.xz".to_string(),
                        size: 339_480_672,
                        browser_download_url: "https://example.com/aarch64.qcow2.xz".to_string(),
                        digest: Some("sha256:qcow2hash".to_string()),
                    },
                    GitHubAsset {
                        name: "haos_generic-aarch64-16.3.img.xz".to_string(),
                        size: 341_537_340,
                        browser_download_url: "https://example.com/aarch64.img.xz".to_string(),
                        digest: Some("sha256:rawhash".to_string()),
                    },
                ],
            };

            let parsed = parse_github_release(release).unwrap();
            assert_eq!(parsed.images.len(), 2);

            let raw = find_image_for_board(&parsed, "generic-aarch64", ImageFormat::Raw).unwrap();
            assert_eq!(raw.sha256, "rawhash");
            assert_eq!(raw.size, 341_537_340);

            let qcow2 =
                find_image_for_board(&parsed, "generic-aarch64", ImageFormat::Qcow2).unwrap();
            assert_eq!(qcow2.sha256, "qcow2hash");
            assert_eq!(qcow2.size, 339_480_672);
        }

        /// The qcow2 is listed first, but a raw-write flow must still get the
        /// raw image - writing the qcow2 to a disk produces a dead card.
        #[test]
        fn test_find_image_for_board_ignores_other_format_listed_first() {
            let release = dual_format_release();

            let raw = find_image_for_board(&release, "generic-aarch64", ImageFormat::Raw).unwrap();
            assert_eq!(raw.format, ImageFormat::Raw);
            assert!(raw.download_url.ends_with(".img.xz"));

            let qcow2 =
                find_image_for_board(&release, "generic-aarch64", ImageFormat::Qcow2).unwrap();
            assert_eq!(qcow2.format, ImageFormat::Qcow2);
            assert!(qcow2.download_url.ends_with(".qcow2.xz"));
        }

        /// generic-x86-64 has no qcow2 build; the VM flows must see that
        /// rather than be handed the raw image.
        #[test]
        fn test_find_image_for_board_absent_format_is_none() {
            let release = dual_format_release();

            assert!(find_image_for_board(&release, "generic-x86-64", ImageFormat::Raw).is_some());
            assert!(find_image_for_board(&release, "generic-x86-64", ImageFormat::Qcow2).is_none());
        }

        #[test]
        fn test_mock_release_offers_both_formats() {
            let release = crate::mock::get_mock_haos_release();

            // Raw for the boards that get flashed
            assert!(find_image_for_board(&release, "rpi5-64", ImageFormat::Raw).is_some());
            assert!(find_image_for_board(&release, "rpi5-64", ImageFormat::Qcow2).is_none());

            // qcow2 for the boards the VM flows use
            assert!(find_image_for_board(&release, "ova", ImageFormat::Qcow2).is_some());
            assert!(
                find_image_for_board(&release, "generic-aarch64", ImageFormat::Qcow2).is_some()
            );
        }

        #[test]
        fn test_haos_image_checksum_treats_empty_as_absent() {
            let mut image = HaosImage {
                board: "rpi5-64".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://example.com/haos_rpi5-64-16.3.img.xz".to_string(),
                size: 100,
                sha256: String::new(),
            };
            // Releases predating GitHub asset digests carry no checksum
            assert_eq!(image.checksum(), None);

            image.sha256 = "   ".to_string();
            assert_eq!(image.checksum(), None);

            image.sha256 = "abc123".to_string();
            assert_eq!(image.checksum(), Some("abc123"));
        }

        #[test]
        fn test_get_cached_image_path_is_format_specific() {
            let raw = HaosImage {
                board: "generic-aarch64".to_string(),
                format: ImageFormat::Raw,
                download_url: "https://example.com/haos_generic-aarch64-16.3.img.xz".to_string(),
                size: 1,
                sha256: String::new(),
            };
            let qcow2 = HaosImage {
                format: ImageFormat::Qcow2,
                download_url: "https://example.com/haos_generic-aarch64-16.3.qcow2.xz".to_string(),
                ..raw.clone()
            };

            let raw_path = get_cached_image_path(&raw).unwrap();
            let qcow2_path = get_cached_image_path(&qcow2).unwrap();

            assert_ne!(raw_path, qcow2_path);
            assert!(raw_path.to_string_lossy().ends_with(".img.xz"));
            assert!(qcow2_path.to_string_lossy().ends_with(".qcow2.xz"));
        }

        #[test]
        fn test_get_cached_image_path_fallback_uses_format_suffix() {
            let image = HaosImage {
                board: "ova".to_string(),
                format: ImageFormat::Qcow2,
                download_url: String::new(),
                size: 1,
                sha256: String::new(),
            };

            let path = get_cached_image_path(&image).unwrap();
            assert!(path.to_string_lossy().ends_with("image.qcow2.xz"));
        }

        /// An empty checksum must not be compared against - it used to fail
        /// every download from a release without a digest.
        #[tokio::test]
        #[serial]
        async fn test_download_image_empty_checksum_is_not_a_mismatch() {
            std::env::remove_var("HA_INSTALLER_MOCK");

            let mut server = mockito::Server::new_async().await;
            let body = b"an image without a published digest";
            let mock = server
                .mock("GET", "/no-digest.img.xz")
                .with_status(200)
                .with_body(body.as_slice())
                .create_async()
                .await;

            let dest = get_cache_dir().unwrap().join("test_empty_checksum.img.xz");
            let _ = std::fs::remove_file(&dest);

            let result = download_image(
                &format!("{}/no-digest.img.xz", server.url()),
                &dest,
                Some(""),
                &crate::NoOpProgress,
            )
            .await;

            assert!(result.is_ok(), "empty digest should be treated as absent");
            assert_eq!(std::fs::read(&dest).unwrap(), body);

            mock.assert_async().await;
            let _ = std::fs::remove_file(&dest);
        }

        /// A download that fails its checksum must leave nothing behind -
        /// least of all a file under the name a cache hit would trust.
        #[tokio::test]
        #[serial]
        async fn test_download_image_checksum_mismatch_leaves_no_files() {
            std::env::remove_var("HA_INSTALLER_MOCK");

            let mut server = mockito::Server::new_async().await;
            let mock = server
                .mock("GET", "/corrupt.img.xz")
                .with_status(200)
                .with_body(b"not what the release promised".as_slice())
                .create_async()
                .await;

            let dest = get_cache_dir()
                .unwrap()
                .join("test_mismatch_cleanup.img.xz");
            let partial = partial_path(&dest);
            let _ = std::fs::remove_file(&dest);
            let _ = std::fs::remove_file(&partial);

            let result = download_image(
                &format!("{}/corrupt.img.xz", server.url()),
                &dest,
                Some(&"0".repeat(64)),
                &crate::NoOpProgress,
            )
            .await;

            assert!(matches!(result, Err(Error::ChecksumMismatch { .. })));
            assert!(!dest.exists(), "final name must never hold bad bytes");
            assert!(!partial.exists(), "partial download must be cleaned up");

            mock.assert_async().await;
        }

        /// A dead connection must leave no partial file under the final name.
        #[tokio::test]
        #[serial]
        async fn test_download_image_http_error_leaves_no_files() {
            std::env::remove_var("HA_INSTALLER_MOCK");

            let mut server = mockito::Server::new_async().await;
            let mock = server
                .mock("GET", "/gone.img.xz")
                .with_status(404)
                .create_async()
                .await;

            let dest = get_cache_dir()
                .unwrap()
                .join("test_http_error_cleanup.img.xz");
            let partial = partial_path(&dest);
            let _ = std::fs::remove_file(&dest);

            let result = download_image(
                &format!("{}/gone.img.xz", server.url()),
                &dest,
                None,
                &crate::NoOpProgress,
            )
            .await;

            assert!(result.is_err());
            assert!(!dest.exists());
            assert!(!partial.exists());

            mock.assert_async().await;
        }

        #[test]
        fn test_partial_path_appends_rather_than_replaces() {
            let path = Path::new("/cache/haos_green-16.3.img.xz");
            let partial = partial_path(path);

            assert_eq!(
                partial,
                Path::new("/cache/haos_green-16.3.img.xz.part"),
                "the archive suffix must survive so the name stays recognisable"
            );
            // cleanup_cache() keys off exactly this extension
            assert_eq!(
                partial.extension().and_then(|e| e.to_str()),
                Some(PARTIAL_EXTENSION)
            );
        }

        #[tokio::test]
        async fn test_cleanup_cache_removes_partials_this_module_creates() {
            let dest = get_cache_dir().unwrap().join("test_cleanup_pairing.img.xz");
            let partial = partial_path(&dest);
            std::fs::write(&partial, b"interrupted").unwrap();

            cleanup_cache().await.unwrap();

            assert!(!partial.exists());
        }

        /// `fetch_image` must not hit the network when a complete copy is
        /// already cached (issue #4: images re-downloaded every run).
        #[tokio::test]
        #[serial]
        async fn test_fetch_image_reuses_cached_download() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            std::env::remove_var("HA_INSTALLER_NO_CACHE");

            let cached = get_cache_dir().unwrap().join("test_fetch_cached.img.xz");
            std::fs::write(&cached, [7u8; 64]).unwrap();

            let image = HaosImage {
                board: "rpi5-64".to_string(),
                format: ImageFormat::Raw,
                // Unroutable: reaching the network at all would fail the test
                download_url: "http://127.0.0.1:59997/test_fetch_cached.img.xz".to_string(),
                size: 64,
                sha256: String::new(),
            };

            let path = fetch_image(&image, &crate::NoOpProgress).await.unwrap();
            assert_eq!(path, cached);
            assert_eq!(std::fs::read(&path).unwrap().len(), 64);

            let _ = std::fs::remove_file(&cached);
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_image_downloads_when_not_cached() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            std::env::remove_var("HA_INSTALLER_NO_CACHE");

            let body = b"freshly downloaded image";
            let mut server = mockito::Server::new_async().await;
            let mock = server
                .mock("GET", "/test_fetch_fresh.img.xz")
                .with_status(200)
                .with_body(body.as_slice())
                .create_async()
                .await;

            let expected = get_cache_dir().unwrap().join("test_fetch_fresh.img.xz");
            let _ = std::fs::remove_file(&expected);

            let image = HaosImage {
                board: "rpi5-64".to_string(),
                format: ImageFormat::Raw,
                download_url: format!("{}/test_fetch_fresh.img.xz", server.url()),
                size: body.len() as u64,
                sha256: hex::encode(Sha256::digest(body)),
            };

            let path = fetch_image(&image, &crate::NoOpProgress).await.unwrap();
            assert_eq!(path, expected);
            assert_eq!(std::fs::read(&path).unwrap(), body);

            mock.assert_async().await;
            let _ = std::fs::remove_file(&expected);
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_image_redownloads_when_cache_disabled() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            std::env::set_var("HA_INSTALLER_NO_CACHE", "1");

            let body = b"re-fetched despite the cache";
            let mut server = mockito::Server::new_async().await;
            let mock = server
                .mock("GET", "/test_fetch_nocache.img.xz")
                .with_status(200)
                .with_body(body.as_slice())
                .expect(1)
                .create_async()
                .await;

            let cached = get_cache_dir().unwrap().join("test_fetch_nocache.img.xz");
            std::fs::write(&cached, body).unwrap();

            let image = HaosImage {
                board: "rpi5-64".to_string(),
                format: ImageFormat::Raw,
                download_url: format!("{}/test_fetch_nocache.img.xz", server.url()),
                size: body.len() as u64,
                sha256: String::new(),
            };

            let path = fetch_image(&image, &crate::NoOpProgress).await.unwrap();
            assert_eq!(path, cached);

            mock.assert_async().await;
            std::env::remove_var("HA_INSTALLER_NO_CACHE");
            let _ = std::fs::remove_file(&cached);
        }
    }

    /// Tests for the extraction safeguards added for F16 and F17
    mod extraction {
        use super::*;
        use std::io::Write;

        /// Write `content` to `path` as a single-stream `.xz` archive
        fn write_xz(path: &Path, content: &[u8]) {
            let file = std::fs::File::create(path).unwrap();
            let mut encoder = xz2::write::XzEncoder::new(file, 1);
            encoder.write_all(content).unwrap();
            encoder.finish().unwrap();
        }

        #[test]
        fn test_read_xz_varint_single_byte() {
            let mut pos = 0;
            assert_eq!(read_xz_varint(&[0x00], &mut pos), Some(0));
            assert_eq!(pos, 1);

            let mut pos = 0;
            assert_eq!(read_xz_varint(&[0x7f], &mut pos), Some(127));
            assert_eq!(pos, 1);
        }

        #[test]
        fn test_read_xz_varint_multi_byte() {
            // 128 = 0x80 0x01 in xz's little-endian base-128 encoding
            let mut pos = 0;
            assert_eq!(read_xz_varint(&[0x80, 0x01], &mut pos), Some(128));
            assert_eq!(pos, 2);

            let mut pos = 0;
            assert_eq!(read_xz_varint(&[0xac, 0x02], &mut pos), Some(300));
        }

        #[test]
        fn test_read_xz_varint_rejects_bad_encodings() {
            // Truncated: continuation bit set but no further byte
            let mut pos = 0;
            assert_eq!(read_xz_varint(&[0x80], &mut pos), None);

            // Non-canonical: padded with a trailing zero byte
            let mut pos = 0;
            assert_eq!(read_xz_varint(&[0x80, 0x00], &mut pos), None);

            // Longer than the nine bytes the format allows
            let mut pos = 0;
            assert_eq!(read_xz_varint(&[0xff; 10], &mut pos), None);

            // Empty input
            let mut pos = 0;
            assert_eq!(read_xz_varint(&[], &mut pos), None);
        }

        #[test]
        fn test_xz_uncompressed_size_matches_the_content() {
            let dir = tempfile::tempdir().unwrap();

            for size in [0usize, 1, 4096, 3 * 1024 * 1024] {
                let archive = dir.path().join(format!("sized_{}.xz", size));
                write_xz(&archive, &vec![0xa5u8; size]);

                assert_eq!(
                    xz_uncompressed_size(&archive),
                    Some(size as u64),
                    "index should report the exact uncompressed size"
                );
            }
        }

        #[test]
        fn test_xz_uncompressed_size_rejects_non_archives() {
            let dir = tempfile::tempdir().unwrap();

            let missing = dir.path().join("absent.xz");
            assert_eq!(xz_uncompressed_size(&missing), None);

            let tiny = dir.path().join("tiny.xz");
            std::fs::write(&tiny, b"nope").unwrap();
            assert_eq!(xz_uncompressed_size(&tiny), None);

            let not_xz = dir.path().join("plain.bin");
            std::fs::write(&not_xz, vec![0u8; 4096]).unwrap();
            assert_eq!(xz_uncompressed_size(&not_xz), None);
        }

        #[test]
        fn test_xz_uncompressed_size_rejects_truncated_archive() {
            let dir = tempfile::tempdir().unwrap();
            let archive = dir.path().join("truncated.xz");
            write_xz(&archive, &vec![1u8; 65536]);

            let full = std::fs::read(&archive).unwrap();
            std::fs::write(&archive, &full[..full.len() - 20]).unwrap();

            assert_eq!(xz_uncompressed_size(&archive), None);
        }

        /// Concatenated streams: the trailing index only covers the last one,
        /// so the parser has to refuse rather than under-report.
        #[test]
        fn test_xz_uncompressed_size_rejects_multi_stream_archive() {
            let dir = tempfile::tempdir().unwrap();
            let first = dir.path().join("first.xz");
            let second = dir.path().join("second.xz");
            write_xz(&first, &vec![2u8; 8192]);
            write_xz(&second, &vec![3u8; 8192]);

            let joined = dir.path().join("joined.xz");
            let mut bytes = std::fs::read(&first).unwrap();
            bytes.extend_from_slice(&std::fs::read(&second).unwrap());
            std::fs::write(&joined, &bytes).unwrap();

            assert_eq!(xz_uncompressed_size(&joined), None);
        }

        #[tokio::test]
        #[serial]
        async fn test_extract_xz_reports_size_and_digest() {
            std::env::remove_var("HA_INSTALLER_MOCK");

            let dir = tempfile::tempdir().unwrap();
            let content = b"the bytes that should come back out again";
            let archive = dir.path().join("digest.img.xz");
            let dest = dir.path().join("digest.img");
            write_xz(&archive, content);

            let extracted = extract_xz(&archive, &dest, &crate::NoOpProgress)
                .await
                .unwrap();

            assert_eq!(extracted.path, dest);
            assert_eq!(extracted.size, content.len() as u64);
            assert_eq!(extracted.sha256, hex::encode(Sha256::digest(content)));
            assert_eq!(std::fs::read(&dest).unwrap(), content);
        }

        /// The xz container CRC-checks what it decodes; a truncated archive
        /// must therefore fail rather than yield a short image.
        #[tokio::test]
        #[serial]
        async fn test_extract_xz_rejects_truncated_archive() {
            std::env::remove_var("HA_INSTALLER_MOCK");

            let dir = tempfile::tempdir().unwrap();
            let archive = dir.path().join("short.img.xz");
            let dest = dir.path().join("short.img");
            write_xz(&archive, &vec![9u8; 512 * 1024]);

            let full = std::fs::read(&archive).unwrap();
            std::fs::write(&archive, &full[..full.len() / 2]).unwrap();

            let result = extract_xz(&archive, &dest, &crate::NoOpProgress).await;

            assert!(result.is_err(), "a truncated archive must not extract");
            assert!(!dest.exists(), "no image may be left under the final name");
            assert!(!partial_path(&dest).exists(), "partial must be cleaned up");
        }

        #[tokio::test]
        #[serial]
        async fn test_extract_xz_reports_determinate_progress() {
            std::env::remove_var("HA_INSTALLER_MOCK");

            use std::sync::{Arc, Mutex};

            struct Recorder {
                seen: Arc<Mutex<Vec<FlashProgress>>>,
            }

            impl crate::ProgressCallback for Recorder {
                fn on_progress(&self, progress: FlashProgress) {
                    self.seen.lock().unwrap().push(progress);
                }
            }

            let dir = tempfile::tempdir().unwrap();
            let archive = dir.path().join("progress.img.xz");
            let dest = dir.path().join("progress.img");
            let size = 25 * 1024 * 1024;
            write_xz(&archive, &vec![0u8; size]);

            let seen = Arc::new(Mutex::new(Vec::new()));
            extract_xz(
                &archive,
                &dest,
                &Recorder {
                    seen: Arc::clone(&seen),
                },
            )
            .await
            .unwrap();

            let seen = seen.lock().unwrap();
            // Now that the uncompressed size is known up front, the bar can
            // move instead of sitting at "indeterminate" for minutes.
            assert!(
                seen.iter()
                    .any(|p| p.total_bytes == size as u64 && p.progress > 0 && p.progress < 100),
                "expected intermediate percentages, got {:?}",
                seen.iter().map(|p| p.progress).collect::<Vec<_>>()
            );
            assert!(seen.iter().all(|p| p.stage == FlashStage::Extracting));
            assert_eq!(seen.last().unwrap().progress, 100);
        }

        #[test]
        fn test_extraction_percentage() {
            assert_eq!(extraction_percentage(0, Some(100)), 0);
            assert_eq!(extraction_percentage(50, Some(100)), 50);
            // Capped below 100 until the stream actually ends
            assert_eq!(extraction_percentage(100, Some(100)), 99);
            assert_eq!(extraction_percentage(200, Some(100)), 99);
            // Unknown total stays indeterminate
            assert_eq!(extraction_percentage(50, None), 0);
            assert_eq!(extraction_percentage(50, Some(0)), 0);
        }

        #[test]
        fn test_verify_extraction_accepts_a_complete_image() {
            assert!(verify_extraction(1024, 1024, Some(1024)).is_ok());
            // No index size available: only the disk write is checked
            assert!(verify_extraction(1024, 1024, None).is_ok());
        }

        #[test]
        fn test_verify_extraction_rejects_a_short_write() {
            let err = verify_extraction(4096, 1024, Some(4096)).unwrap_err();
            assert!(matches!(err, Error::ExtractionFailed(_)));
            assert!(err.to_string().contains("may be full"));
        }

        #[test]
        fn test_verify_extraction_rejects_size_mismatch_against_index() {
            let err = verify_extraction(1024, 1024, Some(4096)).unwrap_err();
            assert!(matches!(err, Error::ExtractionFailed(_)));
            assert!(err.to_string().contains("archive declares"));
        }

        #[test]
        fn test_ensure_free_space_allows_a_small_request() {
            let dir = tempfile::tempdir().unwrap();
            assert!(ensure_free_space(dir.path(), 0).is_ok());
        }

        #[test]
        fn test_ensure_free_space_rejects_an_impossible_request() {
            let dir = tempfile::tempdir().unwrap();

            // Platforms where the figure is unavailable skip the check
            if available_space(dir.path()).is_none() {
                return;
            }

            let err = ensure_free_space(dir.path(), u64::MAX).unwrap_err();
            assert!(matches!(err, Error::InsufficientDiskSpace { .. }));
            assert!(err.to_string().contains("Not enough free disk space"));
        }

        #[test]
        fn test_ensure_free_space_is_skipped_for_unknown_locations() {
            // A path that cannot be queried must not block an install
            let unknown = Path::new("/definitely/not/a/real/mount/point/12345");
            assert!(available_space(unknown).is_none());
            assert!(ensure_free_space(unknown, u64::MAX).is_ok());
        }

        #[cfg(any(unix, windows))]
        #[test]
        fn test_available_space_reports_a_figure_for_the_cache() {
            let cache_dir = get_cache_dir().unwrap();
            let available = available_space(&cache_dir);

            assert!(
                available.is_some(),
                "the cache directory's filesystem should report free space"
            );
            assert!(available.unwrap() > 0);
        }

        /// The figure extraction checks the disk against before it starts,
        /// so a too-small disk fails up front instead of part-way through a
        /// multi-gigabyte write (issue #4).
        #[test]
        fn test_required_space_for_uses_the_archive_index_when_available() {
            // Exact size from the index, plus headroom
            assert_eq!(
                required_space_for(300_000_000, Some(8_000_000_000)),
                8_000_000_000 + FREE_SPACE_MARGIN
            );
        }

        #[test]
        fn test_required_space_for_falls_back_to_a_ratio() {
            assert_eq!(
                required_space_for(300_000_000, None),
                300_000_000 * XZ_FALLBACK_RATIO + FREE_SPACE_MARGIN
            );
        }

        #[test]
        fn test_required_space_for_saturates_instead_of_overflowing() {
            assert_eq!(required_space_for(u64::MAX, None), u64::MAX);
            assert_eq!(required_space_for(0, Some(u64::MAX)), u64::MAX);
        }

        /// A small image extracts normally: the free-space check must not
        /// stand in the way of an install that fits.
        #[tokio::test]
        #[serial]
        async fn test_extract_xz_allows_an_image_that_fits() {
            std::env::remove_var("HA_INSTALLER_MOCK");

            let dir = tempfile::tempdir().unwrap();
            let archive = dir.path().join("fits.img.xz");
            let dest = dir.path().join("fits.img");
            write_xz(&archive, &vec![0u8; 4096]);

            let extracted = extract_xz(&archive, &dest, &crate::NoOpProgress)
                .await
                .unwrap();
            assert_eq!(extracted.size, 4096);
        }

        #[tokio::test]
        #[serial]
        async fn test_extract_xz_missing_archive_errors_before_writing() {
            std::env::remove_var("HA_INSTALLER_MOCK");

            let dir = tempfile::tempdir().unwrap();
            let archive = dir.path().join("absent.img.xz");
            let dest = dir.path().join("absent.img");

            assert!(extract_xz(&archive, &dest, &crate::NoOpProgress)
                .await
                .is_err());
            assert!(!dest.exists());
            assert!(!partial_path(&dest).exists());
        }
    }

    /// Tests for the HTTP clients' timeout configuration (F17)
    mod http_clients {
        use super::*;

        #[test]
        fn test_clients_build() {
            assert!(api_client().is_ok());
            assert!(download_client().is_ok());
        }

        /// Accept a connection and then never reply, so a client without a
        /// read timeout would wait indefinitely.
        async fn silent_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();

            let handle = tokio::spawn(async move {
                let mut held = Vec::new();
                while let Ok((stream, _)) = listener.accept().await {
                    held.push(stream);
                }
            });

            (addr, handle)
        }

        /// A stalled transfer must fail instead of hanging the download stage
        /// forever. Uses the same builder as `download_client`, with a short
        /// timeout so the test does not take a minute.
        #[tokio::test]
        async fn test_download_client_gives_up_on_a_silent_server() {
            let (addr, server) = silent_server().await;

            let client = build_download_client(Duration::from_millis(250)).unwrap();
            let result = client
                .get(format!("http://{}/image.img.xz", addr))
                .send()
                .await;

            assert!(result.is_err(), "a stalled response must time out");
            server.abort();
        }

        /// The same for the metadata endpoints, which use a total timeout.
        #[tokio::test]
        async fn test_api_client_gives_up_on_a_silent_server() {
            let (addr, server) = silent_server().await;

            let client = build_api_client(Duration::from_millis(250)).unwrap();
            let result = client
                .get(format!("http://{}/stable.json", addr))
                .send()
                .await;

            assert!(result.is_err(), "a stalled request must time out");
            server.abort();
        }
    }
}
