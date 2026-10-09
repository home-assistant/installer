//! Image download and extraction functionality
//!
//! This module provides functions for downloading HAOS images and
//! extracting compressed archives.

use crate::error::{Error, Result};
use crate::types::{
    DeviceManifest, FlashProgress, FlashStage, GitHubRelease, HaosImage, HaosRelease, ImageFormat,
    StableVersionInfo,
};
use crate::{Backend, ProgressCallback, ReleaseSource};
use directories::ProjectDirs;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

/// Files owned by one installation attempt, never paths supplied by a caller.
/// Clones keep background extraction alive until its file handles are closed.
#[derive(Clone, Debug)]
pub struct TemporaryImage {
    directory: std::sync::Arc<ImageDirectory>,
    format: ImageFormat,
}

const IMAGE_OWNER_MARKER: &str = "hai-temporary-image-v1";
const UTM_IMPORT_MARKER: &str = ".utm-import";

#[derive(Debug)]
struct ImageDirectory {
    directory: Option<tempfile::TempDir>,
    lock: Option<std::fs::File>,
}

impl ImageDirectory {
    fn path(&self) -> &Path {
        self.directory.as_ref().unwrap().path()
    }
}

impl Drop for ImageDirectory {
    fn drop(&mut self) {
        // No installer ever adopts an existing temporary directory. Once the
        // last owner releases this lock, startup recovery may also remove it
        // unless an external UTM import still needs the source.
        drop(self.lock.take());
        if let Some(directory) = self.directory.take() {
            if let Err(error) = remove_image_directory(&directory.keep()) {
                eprintln!("Could not remove temporary image directory: {error}");
            }
        }
    }
}

impl TemporaryImage {
    /// Create a private, locked directory for one installation's image files.
    pub fn new(cache_dir: &Path, format: ImageFormat) -> Result<Self> {
        use std::io::Write;
        let directory = tempfile::Builder::new()
            .prefix("hai-image-")
            .rand_bytes(16)
            .tempdir_in(cache_dir)?;
        let mut lock = std::fs::File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(directory.path().join(".owner"))?;
        lock.lock()?;
        lock.write_all(IMAGE_OWNER_MARKER.as_bytes())?;
        Ok(Self {
            directory: std::sync::Arc::new(ImageDirectory {
                directory: Some(directory),
                lock: Some(lock),
            }),
            format,
        })
    }

    /// Path of the extracted image inside this installation's directory.
    pub fn path(&self) -> PathBuf {
        let extension = match self.format {
            ImageFormat::Raw => "img",
            ImageFormat::Qcow2 => "qcow2",
        };
        // The unique name also prevents overwriting another Proxmox import.
        self.directory.path().join(format!(
            "{}.{}",
            self.directory.path().file_name().unwrap().to_string_lossy(),
            extension
        ))
    }

    /// Path used to download the compressed archive before extraction.
    pub fn archive_path(&self) -> PathBuf {
        self.directory.path().join("download.xz")
    }

    /// Persist before dispatch: UTM can outlive the installer or its AppleEvent.
    /// An unconfirmed import requires manual cleanup after UTM has finished.
    pub fn begin_utm_import(&self) -> Result<()> {
        let marker = self.directory.path().join(UTM_IMPORT_MARKER);
        let file = std::fs::File::options()
            .write(true)
            .create_new(true)
            .open(&marker)?;
        if let Err(error) = file.sync_all() {
            drop(file);
            // No command was sent. Undo only the marker we just created.
            if let Err(cleanup_error) = std::fs::remove_file(&marker) {
                eprintln!(
                    "Could not remove UTM import marker {}: {cleanup_error}",
                    marker.display()
                );
            }
            return Err(error.into());
        }
        Ok(())
    }

    /// Allow cleanup only after UTM has replied with completion or rejection.
    pub fn finish_utm_import(&self) -> Result<()> {
        std::fs::remove_file(self.directory.path().join(UTM_IMPORT_MARKER))?;
        Ok(())
    }
}

fn valid_board(board: &str) -> bool {
    !board.is_empty()
        && board
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
}

fn parse_version(version: &str) -> Option<Vec<u64>> {
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() < 2
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    parts.into_iter().map(|part| part.parse().ok()).collect()
}

/// Remove legacy stable archives and recover owned temporary directories
/// after a process exit. Downloads are not retained between installs. Unknown
/// names, prereleases, unowned directories, and symlinks are left alone.
pub fn prune_cached_images(cache_dir: &Path) -> Result<()> {
    for entry in std::fs::read_dir(cache_dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            remove_abandoned_image(&entry.path());
            continue;
        }
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str().and_then(|name| name.strip_prefix("haos_")) else {
            continue;
        };
        let Some((stem, _)) = [".img.xz", ".qcow2.xz"]
            .iter()
            .find_map(|suffix| name.strip_suffix(suffix).map(|stem| (stem, *suffix)))
        else {
            continue;
        };
        let Some((board, version)) = stem.rsplit_once('-') else {
            continue;
        };
        let Some(_) = parse_version(version) else {
            continue;
        };
        if !valid_board(board) {
            continue;
        }
        if let Err(error) = std::fs::remove_file(entry.path()) {
            eprintln!("Could not remove legacy cached image: {error}");
        }
    }
    Ok(())
}

fn remove_abandoned_image(path: &Path) {
    let Some(suffix) = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("hai-image-"))
    else {
        return;
    };
    if suffix.len() != 16 || !suffix.bytes().all(|c| c.is_ascii_alphanumeric()) {
        return;
    }
    let marker = path.join(".owner");
    if !std::fs::symlink_metadata(&marker).is_ok_and(|metadata| metadata.is_file()) {
        return;
    }
    let Ok(mut lock) = std::fs::File::options().read(true).write(true).open(marker) else {
        return;
    };
    if lock.try_lock().is_err() {
        return;
    }
    use std::io::Read;
    let mut contents = String::new();
    if lock
        .by_ref()
        .take(64)
        .read_to_string(&mut contents)
        .is_err()
        || contents != IMAGE_OWNER_MARKER
    {
        return;
    }
    drop(lock);
    if let Err(error) = remove_image_directory(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!(
                "Could not remove abandoned image {}: {error}",
                path.display()
            );
        }
    }
}

fn remove_image_directory(path: &Path) -> std::io::Result<()> {
    // An AppleEvent timeout or installer exit does not cancel UTM's import.
    // Retain these sources across both owner drop and startup recovery.
    if path.join(UTM_IMPORT_MARKER).try_exists()? {
        return Ok(());
    }
    // Keep the ownership marker if a busy file prevents cleanup, so startup
    // can retry instead of treating the partially removed directory as unowned.
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_name() == ".owner" {
            continue;
        }
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    std::fs::remove_file(path.join(".owner"))?;
    std::fs::remove_dir(path)
}

/// Home Assistant version API for stable releases
const VERSION_URL: &str = "https://version.home-assistant.io/stable.json";

/// GitHub API URL for HAOS releases
const HAOS_RELEASES_API: &str =
    "https://api.github.com/repos/home-assistant/operating-system/releases";

/// User agent for API requests
const USER_AGENT: &str = concat!("HomeAssistantInstaller/", env!("CARGO_PKG_VERSION"));

static HTTP_CLIENT: LazyLock<reqwest::Result<reqwest::Client>> =
    LazyLock::new(|| http_client(Duration::from_secs(30)));

fn http_client(read_timeout: Duration) -> reqwest::Result<reqwest::Client> {
    let builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(read_timeout);
    // Tests use independent Tokio runtimes and may reuse mock server ports.
    #[cfg(test)]
    let builder = builder.pool_max_idle_per_host(0);
    builder.build()
}

fn shared_client() -> Result<&'static reqwest::Client> {
    HTTP_CLIENT.as_ref().map_err(|error| {
        Error::DownloadFailed(format!("Could not initialize HTTP client: {error}"))
    })
}

fn check_space(path: &Path, required: u64, available: u64) -> Result<()> {
    if available < required {
        return Err(Error::DownloadFailed(format!(
            "Not enough free space in {}: need {required} bytes, but only {available} bytes are available. Free up disk space and try again.",
            path.display()
        )));
    }
    Ok(())
}

const METADATA_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECTION_FAILURE_MESSAGE: &str =
    "Cannot reach version.home-assistant.io. Check your internet connection and try again.";
const GITHUB_CONNECTION_FAILURE_MESSAGE: &str =
    "Cannot reach GitHub release information. Check your internet connection and try again.";
static RELEASE_CACHE: LazyLock<Mutex<HashMap<String, HaosRelease>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// How often to send progress updates (every N bytes)
const PROGRESS_UPDATE_INTERVAL: u64 = 10 * 1024 * 1024; // 10 MB

/// Get the cache directory for downloaded images
pub(crate) fn get_cache_dir() -> Result<PathBuf> {
    let project_dirs = ProjectDirs::from("io", "home-assistant", "installer")
        .ok_or_else(|| Error::InvalidConfig("Could not determine cache directory".to_string()))?;

    let cache_dir = project_dirs.cache_dir().to_path_buf();
    std::fs::create_dir_all(&cache_dir)?;

    Ok(cache_dir)
}

/// Fetch the device manifest
async fn get_device_manifest() -> Result<DeviceManifest> {
    get_device_manifest_from_url(VERSION_URL).await
}

async fn get_device_manifest_from_url(url: &str) -> Result<DeviceManifest> {
    get_device_manifest_with_timeout(url, std::time::Duration::from_secs(30)).await
}

async fn get_device_manifest_with_timeout(
    url: &str,
    deadline: std::time::Duration,
) -> Result<DeviceManifest> {
    let stable = tokio::time::timeout(deadline, get_stable_version_from_url(url))
        .await
        .map_err(|_| Error::DownloadFailed("Timed out fetching device availability".into()))??;
    let mut manifest = crate::manifest::bundled_manifest();
    manifest
        .devices
        .retain(|device| stable.hassos.contains_key(&device.haos.board));
    Ok(manifest)
}

/// Fetch the stable version info from Home Assistant (internal version with custom URL)
async fn get_stable_version_from_url(url: &str) -> Result<StableVersionInfo> {
    let client = shared_client()?;
    let response = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .timeout(METADATA_TIMEOUT)
        .send()
        .await
        .map_err(|error| metadata_request_error(error, CONNECTION_FAILURE_MESSAGE))?;

    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "Failed to fetch version info: HTTP {}",
            response.status()
        )));
    }

    let version_info: StableVersionInfo = response
        .json()
        .await
        .map_err(|error| metadata_request_error(error, CONNECTION_FAILURE_MESSAGE))?;
    Ok(version_info)
}

fn metadata_request_error(error: reqwest::Error, message: &str) -> Error {
    if error.is_timeout() || error.is_connect() {
        Error::DownloadFailed(message.to_string())
    } else {
        error.into()
    }
}

/// Fetch the stable version info from Home Assistant
pub(crate) async fn get_stable_version() -> Result<StableVersionInfo> {
    get_stable_version_from_url(VERSION_URL).await
}

async fn check_connection_from_url(url: &str, timeout: Duration) -> Result<()> {
    let response = reqwest::Client::new()
        .get(url)
        .header("User-Agent", USER_AGENT)
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| Error::DownloadFailed(CONNECTION_FAILURE_MESSAGE.to_string()))?;
    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "The Home Assistant version service is unavailable (HTTP {}). Try again later.",
            response.status()
        )));
    }
    response.json::<StableVersionInfo>().await.map_err(|error| {
        if error.is_timeout() {
            return Error::DownloadFailed(CONNECTION_FAILURE_MESSAGE.to_string());
        }
        Error::DownloadFailed(
            "The Home Assistant version service returned an incomplete or invalid response. Check for a network sign-in page and try again."
                .to_string(),
        )
    })?;
    Ok(())
}

/// Get the latest stable HAOS version from the version API
async fn get_latest_haos_version() -> Result<String> {
    let version_info = get_stable_version().await?;

    newest_version(version_info.hassos.values())
        .ok_or_else(|| Error::DownloadFailed("No HAOS versions found in stable.json".to_string()))
}

/// The HAOS version stable.json lists for `board`.
///
/// Boards can be held back during a staged rollout, so the version a board
/// should get is its own entry, not whatever another board is on.
async fn get_latest_haos_version_for_board(board: &str) -> Result<String> {
    version_for_board(&get_stable_version().await?, board)
}

fn version_for_board(version_info: &StableVersionInfo, board: &str) -> Result<String> {
    version_info.hassos.get(board).cloned().ok_or_else(|| {
        Error::DownloadFailed(format!(
            "Home Assistant OS has no current release for board: {}",
            board
        ))
    })
}

/// The newest of a set of HAOS versions (`18.3` beats `9.5`), so the answer
/// doesn't depend on HashMap order.
fn newest_version<'a>(versions: impl Iterator<Item = &'a String>) -> Option<String> {
    fn numeric(version: &str) -> Vec<u32> {
        version
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    }

    versions.max_by_key(|version| numeric(version)).cloned()
}

/// Fetch the latest HAOS release information
async fn fetch_latest_release() -> Result<HaosRelease> {
    let version = get_latest_haos_version().await?;
    fetch_release(&version).await
}

/// Fetch a specific HAOS release by version (internal version with custom base URL)
async fn fetch_release_from_api(api_base_url: &str, version: &str) -> Result<HaosRelease> {
    let client = shared_client()?;
    let response = client
        .get(format!("{}/tags/{}", api_base_url, version))
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github.v3+json")
        .timeout(METADATA_TIMEOUT)
        .send()
        .await
        .map_err(|error| metadata_request_error(error, GITHUB_CONNECTION_FAILURE_MESSAGE))?;

    if !response.status().is_success() {
        let status = response.status();
        if status == reqwest::StatusCode::FORBIDDEN
            || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            let headers = response.headers().clone();
            let message = response.json::<serde_json::Value>().await.ok();
            let rate_limited = status == reqwest::StatusCode::TOO_MANY_REQUESTS
                || headers
                    .get("x-ratelimit-remaining")
                    .is_some_and(|v| v == "0")
                || headers.contains_key("retry-after")
                || message
                    .as_ref()
                    .and_then(|v| v["message"].as_str())
                    .is_some_and(|v| v.to_ascii_lowercase().contains("rate limit"));
            if rate_limited {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let seconds = rate_limit_wait(&headers, now);
                let minutes = seconds.div_ceil(60).max(1);
                let unit = if minutes == 1 { "minute" } else { "minutes" };
                return Err(Error::RateLimited(format!(
                    "GitHub's request limit has been reached for this network. Wait at least {minutes} {unit}, then try again."
                )));
            }
            return Err(Error::DownloadFailed(format!(
                "GitHub refused access to release {version} (HTTP {status}). Try again later or check your network's access to GitHub."
            )));
        }
        return Err(Error::DownloadFailed(format!(
            "Failed to fetch release {}: HTTP {}",
            version,
            response.status()
        )));
    }

    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|error| metadata_request_error(error, GITHUB_CONNECTION_FAILURE_MESSAGE))?;
    parse_github_release(release)
}

fn rate_limit_wait(headers: &reqwest::header::HeaderMap, now: u64) -> u64 {
    let number = |name: &str| headers.get(name)?.to_str().ok()?.parse::<u64>().ok();
    let retry_after = number("retry-after").unwrap_or(0);
    let reset = if headers
        .get("x-ratelimit-remaining")
        .is_some_and(|v| v == "0")
    {
        number("x-ratelimit-reset").unwrap_or(0).saturating_sub(now)
    } else {
        0
    };
    retry_after.max(reset).max(60)
}

async fn fetch_cached_release(
    cache: &Mutex<HashMap<String, HaosRelease>>,
    api_base_url: &str,
    version: &str,
) -> Result<HaosRelease> {
    // Serialize misses so concurrent installations do not spend multiple API requests.
    let mut cache = cache.lock().await;
    if let Some(release) = cache.get(version) {
        return Ok(release.clone());
    }
    let release = fetch_release_from_api(api_base_url, version).await?;
    cache.insert(version.to_string(), release.clone());
    Ok(release)
}

/// Fetch a specific HAOS release by version
async fn fetch_release(version: &str) -> Result<HaosRelease> {
    fetch_cached_release(&RELEASE_CACHE, HAOS_RELEASES_API, version).await
}

/// Fetch HAOS release info for a specific version (or "latest")
async fn get_haos_release(version: &str) -> Result<HaosRelease> {
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
        let (suffix, format) = if asset.name.ends_with(".img.xz") {
            (".img.xz", ImageFormat::Raw)
        } else if asset.name.ends_with(".qcow2.xz") {
            (".qcow2.xz", ImageFormat::Qcow2)
        } else {
            continue;
        };

        // Parse board name from filename: haos_{board}-{version}.img.xz
        let board = match parse_board_from_filename_with_suffix(&asset.name, &version, suffix) {
            Ok(b) => b,
            Err(_) => continue,
        };

        images.push(HaosImage {
            board,
            format,
            download_url: asset.browser_download_url,
            size: asset.size,
            digest: asset.digest,
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
    parse_board_from_filename_with_suffix(filename, version, ".img.xz")
}

/// Require the SHA-256 digest supplied by GitHub's release metadata over HTTPS.
/// Missing/unknown digests must never downgrade an installation to an XZ-only check.
pub(crate) fn expected_sha256(image: &HaosImage) -> Result<[u8; 32]> {
    let digest = image.digest.as_deref().ok_or_else(|| {
        Error::VerificationFailed(
            "GitHub did not provide a SHA-256 digest for this image; installation stopped. Try again later.".to_string(),
        )
    })?;
    let mut expected = [0; 32];
    let valid = digest
        .strip_prefix("sha256:")
        .is_some_and(|value| hex::decode_to_slice(value, &mut expected).is_ok());
    if !valid {
        return Err(Error::VerificationFailed(
            "GitHub provided an invalid or unsupported image digest; installation stopped."
                .to_string(),
        ));
    }
    Ok(expected)
}

/// Download and verify the compressed image before permitting extraction.
pub(crate) async fn download_image<P: ProgressCallback>(
    image: &HaosImage,
    dest_path: &Path,
    progress_callback: &P,
) -> Result<()> {
    download_image_with_client(
        image,
        dest_path,
        progress_callback,
        shared_client()?,
        |path| fs2::available_space(path),
    )
    .await
}

async fn download_image_with_client<P: ProgressCallback>(
    image: &HaosImage,
    dest_path: &Path,
    progress_callback: &P,
    client: &reqwest::Client,
    available_space: impl FnOnce(&Path) -> std::io::Result<u64>,
) -> Result<()> {
    let expected = expected_sha256(image)?;
    let directory = dest_path.parent().ok_or_else(|| {
        Error::InvalidConfig("Image destination must have a parent directory".into())
    })?;
    check_space(directory, image.size, available_space(directory)?)?;
    let url = &image.download_url;
    let response = client.get(url).send().await?;

    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "HTTP {} for {}",
            response.status(),
            url
        )));
    }

    let total_size = image.size;

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 0,
        bytes_processed: 0,
        total_bytes: total_size,
        message: "Starting download...".to_string(),
    });

    // Keep unverified bytes private, and remove them on error or cancellation.
    // Installation downloads live inside an owned TemporaryImage directory;
    // startup pruning reclaims abandoned directories, including nested temp files.
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    let mut downloaded: u64 = 0;
    let mut last_progress_update: u64 = 0;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;

        if chunk.len() as u64 > image.size.saturating_sub(downloaded) {
            return Err(Error::DownloadFailed(
                "Image exceeds the size reported by GitHub; download discarded.".into(),
            ));
        }

        use std::io::Write;
        file.write_all(&chunk)?;
        hasher.update(&chunk);

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

    if downloaded != image.size {
        return Err(Error::DownloadFailed(format!(
            "Incomplete image: expected {} bytes, received {downloaded}.",
            image.size
        )));
    }
    let actual: [u8; 32] = hasher.finalize().into();
    if actual != expected {
        return Err(Error::ChecksumMismatch {
            expected: hex::encode(expected),
            actual: hex::encode(actual),
        });
    }
    file.persist(dest_path)
        .map_err(|error| Error::Io(error.error))?;

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 100,
        bytes_processed: downloaded,
        total_bytes: total_size,
        message: "Download complete".to_string(),
    });

    Ok(())
}

// Bound decoder memory and work even if an archive declares an enormous image.
const XZ_MEMORY_LIMIT: u64 = 256 * 1024 * 1024;
const MAX_EXTRACTED_SIZE: u64 = 64 * 1024 * 1024 * 1024;

fn xz_decoder(input: &mut std::fs::File) -> Result<xz2::read::XzDecoder<&mut std::fs::File>> {
    let stream =
        xz2::stream::Stream::new_stream_decoder(XZ_MEMORY_LIMIT, xz2::stream::CONCATENATED)
            .map_err(|error| Error::ExtractionFailed(error.to_string()))?;
    Ok(xz2::read::XzDecoder::new_stream(input, stream))
}

fn read_xz(decoder: &mut impl std::io::Read, buffer: &mut [u8]) -> Result<usize> {
    decoder.read(buffer).map_err(|error| {
        Error::ExtractionFailed(format!(
            "Downloaded image is corrupt, incomplete, or exceeds the decoder memory limit ({error}); try downloading again."
        ))
    })
}

/// Reports extraction progress from the compressed bytes the decoder consumed.
///
/// Both passes of `extract_archive` read the whole archive, so each one fills
/// half of the bar. The byte counter stays within the archive size, and 100%
/// is left to the caller for when the output is synced and in place.
struct ExtractionProgress<'a> {
    sender: &'a std::sync::mpsc::Sender<FlashProgress>,
    archive_size: u64,
    last_percent: u8,
}

impl ExtractionProgress<'_> {
    fn report(&mut self, pass: u64, consumed: u64) {
        if self.archive_size == 0 {
            return;
        }

        let consumed = consumed.min(self.archive_size);
        let bytes_processed = (pass * self.archive_size + consumed) / 2;
        let percent = ((bytes_processed as f64 / self.archive_size as f64 * 100.0) as u8).min(99);
        if percent == self.last_percent {
            return;
        }

        self.last_percent = percent;
        let _ = self.sender.send(FlashProgress {
            stage: FlashStage::Extracting,
            progress: percent,
            bytes_processed,
            total_bytes: self.archive_size,
            message: "Extracting image...".to_string(),
        });
    }
}

fn extract_archive(
    archive: &Path,
    destination: &Path,
    progress: &std::sync::mpsc::Sender<FlashProgress>,
    mut available_space: impl FnMut(&Path) -> std::io::Result<u64>,
    max_extracted_size: u64,
) -> Result<u64> {
    use std::io::{Seek, Write};
    let directory = destination.parent().ok_or_else(|| {
        Error::InvalidConfig("Image destination must have a parent directory".into())
    })?;
    let available = available_space(directory)?;
    let mut input = std::fs::File::open(archive)?;
    let mut progress = ExtractionProgress {
        sender: progress,
        archive_size: input.metadata()?.len(),
        last_percent: 0,
    };
    let mut buffer = [0; 64 * 1024];
    let mut expected_size = 0;
    {
        // Release metadata has no extracted size. Validate/count all XZ streams
        // without writing first; the archive already occupies its compressed space.
        let mut decoder = xz_decoder(&mut input)?;
        loop {
            let count = read_xz(&mut decoder, &mut buffer)?;
            if count == 0 {
                break;
            }
            expected_size += count as u64;
            progress.report(0, decoder.total_in());
            check_space(directory, expected_size, available)?;
            if expected_size > max_extracted_size {
                return Err(Error::ExtractionFailed(
                    "Image exceeds the supported extracted size of 64 GiB.".into(),
                ));
            }
        }
    }
    check_space(directory, expected_size, available_space(directory)?)?;
    input.rewind()?;
    let mut decoder = xz_decoder(&mut input)?;
    let mut output = tempfile::NamedTempFile::new_in(directory)?;
    let mut extracted = 0;
    loop {
        let count = read_xz(&mut decoder, &mut buffer)?;
        if count == 0 {
            break;
        }
        extracted += count as u64;
        if extracted > expected_size {
            return Err(Error::ExtractionFailed(
                "Extracted image size changed.".into(),
            ));
        }
        output.write_all(&buffer[..count])?;
        progress.report(1, decoder.total_in());
    }
    if extracted != expected_size {
        return Err(Error::ExtractionFailed(
            "Extracted image size changed.".into(),
        ));
    }
    output.as_file().sync_all()?;
    output
        .persist(destination)
        .map_err(|error| Error::Io(error.error))?;
    Ok(extracted)
}

/// Extract a .xz compressed file
pub(crate) async fn extract_xz<P: ProgressCallback>(
    archive_path: &Path,
    dest_path: &Path,
    progress_callback: &P,
) -> Result<()> {
    extract_xz_owned(
        archive_path,
        dest_path,
        progress_callback,
        None,
        MAX_EXTRACTED_SIZE,
    )
    .await
}

async fn extract_xz_owned<P: ProgressCallback>(
    archive_path: &Path,
    dest_path: &Path,
    progress_callback: &P,
    owner: Option<TemporaryImage>,
    max_extracted_size: u64,
) -> Result<()> {
    use std::sync::mpsc;

    // Progress is measured against the compressed archive, which is the only
    // size known up front. An empty or unreadable size keeps it indeterminate.
    let archive_size = std::fs::metadata(archive_path).map_or(0, |metadata| metadata.len());
    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Extracting,
        progress: 0,
        bytes_processed: 0,
        total_bytes: archive_size,
        message: "Extracting image...".to_string(),
    });

    // Create channel for progress updates
    let (progress_tx, progress_rx) = mpsc::channel();

    let archive_path_clone = archive_path.to_path_buf();
    let dest_path_clone = dest_path.to_path_buf();

    let extract_handle = tokio::task::spawn_blocking(move || {
        let _owner = owner;
        let result = extract_archive(
            &archive_path_clone,
            &dest_path_clone,
            &progress_tx,
            |path| fs2::available_space(path),
            max_extracted_size,
        );
        if matches!(result, Err(Error::ExtractionFailed(_))) {
            // All archive handles are closed before removal (also on Windows).
            let _ = std::fs::remove_file(&archive_path_clone);
        }
        result
    });

    // Forward progress updates while waiting for extraction to complete
    loop {
        match progress_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(progress) => progress_callback.on_progress(progress),
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

    extract_handle
        .await
        .map_err(|e| Error::ExtractionFailed(e.to_string()))??;

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Extracting,
        progress: 100,
        bytes_processed: archive_size,
        total_bytes: archive_size,
        message: "Extraction complete".to_string(),
    });

    Ok(())
}

impl ReleaseSource for Backend {
    async fn check_connection(&self) -> Result<()> {
        check_connection_from_url(VERSION_URL, METADATA_TIMEOUT).await
    }

    async fn get_device_manifest(&self) -> Result<DeviceManifest> {
        get_device_manifest().await
    }

    async fn get_haos_release(&self, version: &str) -> Result<HaosRelease> {
        get_haos_release(version).await
    }

    async fn get_latest_haos_release_for_board(&self, board: &str) -> Result<HaosRelease> {
        let version = get_latest_haos_version_for_board(board).await?;
        fetch_release(&version).await
    }

    async fn download_image<P: ProgressCallback>(
        &self,
        image: &HaosImage,
        dest_path: &Path,
        progress_callback: &P,
    ) -> Result<()> {
        download_image(image, dest_path, progress_callback).await
    }

    async fn extract_xz<P: ProgressCallback>(
        &self,
        archive_path: &Path,
        dest_path: &Path,
        progress_callback: &P,
    ) -> Result<()> {
        extract_xz(archive_path, dest_path, progress_callback).await
    }

    async fn extract_temporary_image<P: ProgressCallback>(
        &self,
        image: &TemporaryImage,
        progress_callback: &P,
    ) -> Result<()> {
        extract_xz_owned(
            &image.archive_path(),
            &image.path(),
            progress_callback,
            Some(image.clone()),
            MAX_EXTRACTED_SIZE,
        )
        .await
    }

    fn cache_dir(&self) -> Result<PathBuf> {
        get_cache_dir()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image_for_data(url: &str, data: &[u8]) -> HaosImage {
        HaosImage {
            board: "test".into(),
            format: ImageFormat::Raw,
            download_url: url.into(),
            size: data.len() as u64,
            digest: Some(format!("sha256:{}", hex::encode(Sha256::digest(data)))),
        }
    }

    fn compressed(data: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut encoder = xz2::write::XzEncoder::new(Vec::new(), 1);
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    #[tokio::test]
    async fn stalled_headers_and_body_time_out_without_publishing_partial_files() {
        use std::io::{Read, Write};
        for send_headers in [false, true] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/image.xz", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = [0; 4096];
                assert!(stream.read(&mut request).unwrap() > 0);
                if send_headers {
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\na")
                        .unwrap();
                }
                std::thread::sleep(Duration::from_millis(400));
            });
            let directory = tempfile::tempdir().unwrap();
            let destination = directory.path().join("image.xz");
            std::fs::write(&destination, b"previous image").unwrap();
            let client = http_client(Duration::from_millis(100)).unwrap();
            let result = download_image_with_client(
                &image_for_data(&url, b"abcd"),
                &destination,
                &crate::NoOpProgress,
                &client,
                |path| fs2::available_space(path),
            )
            .await;
            assert!(matches!(result, Err(Error::Network(error)) if error.is_timeout()));
            assert_eq!(std::fs::read(&destination).unwrap(), b"previous image");
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn steady_download_can_exceed_the_read_timeout_in_total() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/image.xz", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_nodelay(true).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 4096];
            assert!(stream.read(&mut request).unwrap() > 0);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n")
                .unwrap();
            for byte in b"0123456789" {
                stream.write_all(&[*byte]).unwrap();
                std::thread::sleep(Duration::from_millis(40));
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("image.xz");
        let client = http_client(Duration::from_millis(200)).unwrap();
        download_image_with_client(
            &image_for_data(&url, b"0123456789"),
            &destination,
            &crate::NoOpProgress,
            &client,
            |path| fs2::available_space(path),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(destination).unwrap(), b"0123456789");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn clean_short_body_without_content_length_reports_incomplete_download() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/image.xz", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 4096];
            assert!(stream.read(&mut request).unwrap() > 0);
            stream.write_all(b"HTTP/1.0 200 OK\r\n\r\ndat").unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let error = download_image(
            &image_for_data(&url, b"data"),
            &directory.path().join("image.xz"),
            &crate::NoOpProgress,
        )
        .await
        .unwrap_err()
        .to_string();
        server.join().unwrap();
        assert!(error.contains("Incomplete image: expected 4 bytes, received 3"));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn insufficient_compressed_space_fails_before_network_request() {
        let mut server = mockito::Server::new_async().await;
        let request = server
            .mock("GET", "/image.xz")
            .expect(0)
            .create_async()
            .await;
        let image = image_for_data(&format!("{}/image.xz", server.url()), b"data");
        for existing_destination in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let destination = directory.path().join("image.xz");
            if existing_destination {
                std::fs::write(&destination, b"previous image").unwrap();
            }
            let error = download_image_with_client(
                &image,
                &destination,
                &crate::NoOpProgress,
                shared_client().unwrap(),
                |path| {
                    assert_eq!(path, directory.path());
                    Ok(3)
                },
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(error.contains("need 4 bytes, but only 3 bytes"));
            assert!(error.contains("Free up disk space"));
            assert!(error.contains(directory.path().to_str().unwrap()));
            if existing_destination {
                assert_eq!(std::fs::read(&destination).unwrap(), b"previous image");
            } else {
                assert!(!destination.exists());
            }
            assert_eq!(
                std::fs::read_dir(directory.path()).unwrap().count(),
                usize::from(existing_destination)
            );
        }
        request.assert_async().await;
    }

    #[tokio::test]
    async fn compressed_size_must_match_metadata_even_when_the_digest_matches() {
        let mut server = mockito::Server::new_async().await;
        let request = server
            .mock("GET", "/image.xz")
            .with_body(b"data")
            .expect(2)
            .create_async()
            .await;
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("image.xz");
        for size in [3, 5] {
            let mut image = image_for_data(&format!("{}/image.xz", server.url()), b"data");
            image.size = size;
            assert!(matches!(
                download_image(&image, &destination, &crate::NoOpProgress).await,
                Err(Error::DownloadFailed(_))
            ));
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        }
        request.assert_async().await;
    }

    #[test]
    fn insufficient_extracted_space_preserves_destination_without_partial_output() {
        for space_readings in [vec![9], vec![10, 9]] {
            for existing_destination in [false, true] {
                let directory = tempfile::tempdir().unwrap();
                let archive = directory.path().join("image.xz");
                let destination = directory.path().join("image.img");
                let data = compressed(b"1234567890");
                std::fs::write(&archive, &data).unwrap();
                if existing_destination {
                    std::fs::write(&destination, b"previous image").unwrap();
                }
                let (tx, rx) = std::sync::mpsc::channel();
                let mut readings = space_readings.iter();
                let error = extract_archive(
                    &archive,
                    &destination,
                    &tx,
                    |path| {
                        assert_eq!(path, directory.path());
                        Ok(*readings.next().expect("unexpected space lookup"))
                    },
                    MAX_EXTRACTED_SIZE,
                )
                .unwrap_err()
                .to_string();
                assert!(error.contains("need 10 bytes, but only 9 bytes"));
                assert!(readings.next().is_none(), "every space guard must run");
                // The measuring pass fills at most half the bar; writing never started.
                assert!(rx.try_iter().all(|progress| progress.progress <= 50));
                assert_eq!(std::fs::read(&archive).unwrap(), data);
                if existing_destination {
                    assert_eq!(std::fs::read(&destination).unwrap(), b"previous image");
                } else {
                    assert!(!destination.exists());
                }
                assert_eq!(
                    std::fs::read_dir(directory.path()).unwrap().count(),
                    1 + usize::from(existing_destination)
                );
            }
        }
    }

    #[tokio::test]
    async fn extraction_rejects_oversized_dictionary_before_publication() {
        // Valid XZ for b"image" with a 512 MiB LZMA2 dictionary. The block header
        // was generated by liblzma's lzma_block_header_encode; fixed bytes avoid
        // allocating a large encoder dictionary during this test.
        let data = [
            0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x04, 0xe6, 0xd6, 0xb4, 0x46, 0x02, 0xc0,
            0x09, 0x05, 0x21, 0x01, 0x22, 0x00, 0x6b, 0x7d, 0x0b, 0xba, 0x01, 0x00, 0x04, 0x69,
            0x6d, 0x61, 0x67, 0x65, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x17, 0x3c, 0xac, 0x6d, 0x38,
            0xd8, 0x6f, 0x00, 0x01, 0x1d, 0x05, 0xb8, 0x2d, 0x80, 0xaf, 0x1f, 0xb6, 0xf3, 0x7d,
            0x01, 0x00, 0x00, 0x00, 0x00, 0x04, 0x59, 0x5a,
        ];
        let mut stream =
            xz2::stream::Stream::new_stream_decoder(XZ_MEMORY_LIMIT, xz2::stream::CONCATENATED)
                .unwrap();
        assert_eq!(
            stream.process(&data, &mut [0; 16], xz2::stream::Action::Finish),
            Err(xz2::stream::Error::MemLimit),
        );
        assert_eq!(stream.total_out(), 0);

        for existing_destination in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let archive = directory.path().join("image.xz");
            let destination = directory.path().join("image.img");
            std::fs::write(&archive, data).unwrap();
            if existing_destination {
                std::fs::write(&destination, b"previous image").unwrap();
            }
            let error = extract_xz(&archive, &destination, &crate::NoOpProgress)
                .await
                .unwrap_err();
            assert!(matches!(error, Error::ExtractionFailed(_)));
            assert!(error.to_string().contains("memory limit reached"));
            if existing_destination {
                assert_eq!(std::fs::read(&destination).unwrap(), b"previous image");
            } else {
                assert!(!destination.exists());
            }
            assert!(!archive.exists());
            assert_eq!(
                std::fs::read_dir(directory.path()).unwrap().count(),
                usize::from(existing_destination),
            );
        }
    }

    #[tokio::test]
    async fn extraction_enforces_output_limit_before_publication() {
        const LIMIT: u64 = 64 * 1024;
        for size in [LIMIT - 1, LIMIT, LIMIT + 1] {
            for existing_destination in [false, true] {
                let directory = tempfile::tempdir().unwrap();
                let archive = directory.path().join("image.xz");
                let destination = directory.path().join("image.img");
                let contents = vec![42; size as usize];
                // Each stream fits separately; the limit applies to their total.
                let mut data = compressed(&contents[..contents.len() / 2]);
                data.extend(compressed(&contents[contents.len() / 2..]));
                std::fs::write(&archive, data).unwrap();
                if existing_destination {
                    std::fs::write(&destination, b"previous image").unwrap();
                }
                let result =
                    extract_xz_owned(&archive, &destination, &crate::NoOpProgress, None, LIMIT)
                        .await;
                if size <= LIMIT {
                    result.unwrap();
                    assert_eq!(std::fs::read(&destination).unwrap(), contents);
                    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
                } else {
                    assert!(matches!(
                        result,
                        Err(Error::ExtractionFailed(message))
                            if message == "Image exceeds the supported extracted size of 64 GiB."
                    ));
                    if existing_destination {
                        assert_eq!(std::fs::read(&destination).unwrap(), b"previous image");
                    } else {
                        assert!(!destination.exists());
                    }
                    assert!(!archive.exists());
                    assert_eq!(
                        std::fs::read_dir(directory.path()).unwrap().count(),
                        usize::from(existing_destination),
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn extraction_counts_and_publishes_all_concatenated_streams() {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("image.xz");
        let destination = directory.path().join("image.img");
        let mut data = compressed(b"first");
        data.extend([0; 4]);
        data.extend(compressed(b"second"));
        data.extend([0; 4]);
        std::fs::write(&archive, data).unwrap();
        std::fs::write(&destination, b"previous image").unwrap();
        extract_xz(&archive, &destination, &crate::NoOpProgress)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"firstsecond");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    }

    #[tokio::test]
    async fn extraction_rejects_truncated_second_stream_and_trailing_garbage() {
        for trailer in [&compressed(b"second")[..20], b"garbage"] {
            let directory = tempfile::tempdir().unwrap();
            let archive = directory.path().join("image.xz");
            let destination = directory.path().join("image.img");
            let mut data = compressed(b"first");
            data.extend(trailer);
            std::fs::write(&archive, data).unwrap();
            std::fs::write(&destination, b"previous image").unwrap();
            assert!(extract_xz(&archive, &destination, &crate::NoOpProgress)
                .await
                .is_err());
            assert_eq!(std::fs::read(&destination).unwrap(), b"previous image");
            assert!(!archive.exists());
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        }
    }

    #[tokio::test]
    async fn failed_extraction_promotion_removes_partial_file() {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("image.xz");
        let destination = directory.path().join("image.img");
        std::fs::write(&archive, compressed(b"image")).unwrap();
        std::fs::create_dir(&destination).unwrap();
        assert!(extract_xz(&archive, &destination, &crate::NoOpProgress)
            .await
            .is_err());
        assert!(destination.is_dir());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    }

    #[tokio::test]
    async fn download_rejects_missing_or_invalid_digest_before_touching_destination() {
        let mut server = mockito::Server::new_async().await;
        let request = server
            .mock("GET", "/image.xz")
            .expect(0)
            .create_async()
            .await;
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("image.xz");
        std::fs::write(&destination, b"existing image").unwrap();
        for digest in [
            None,
            Some("".into()),
            Some("sha256:".into()),
            Some(format!("sha512:{}", "a".repeat(64))),
            Some(format!("sha256:{}", "g".repeat(64))),
            Some(format!("sha256:{}", "a".repeat(63))),
            Some(format!("sha256:{}", "a".repeat(65))),
        ] {
            let mut image = image_for_data(&format!("{}/image.xz", server.url()), b"");
            image.digest = digest;
            assert!(matches!(
                download_image(&image, &destination, &crate::NoOpProgress).await,
                Err(Error::VerificationFailed(_))
            ));
            assert_eq!(std::fs::read(&destination).unwrap(), b"existing image");
        }
        request.assert_async().await;
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn download_rejects_valid_xz_with_wrong_digest_and_keeps_existing_file() {
        use std::io::Write;
        let mut encoder = xz2::write::XzEncoder::new(Vec::new(), 1);
        encoder
            .write_all(b"an attacker can generate a valid XZ checksum")
            .unwrap();
        let archive = encoder.finish().unwrap();
        let mut server = mockito::Server::new_async().await;
        let request = server
            .mock("GET", "/image.xz")
            .with_body(&archive)
            .expect(2)
            .create_async()
            .await;
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("image.xz");
        let mut image = image_for_data(&format!("{}/image.xz", server.url()), b"published bytes");
        image.size = archive.len() as u64;
        assert!(matches!(
            download_image(&image, &destination, &crate::NoOpProgress).await,
            Err(Error::ChecksumMismatch { .. })
        ));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        std::fs::write(&destination, b"previous verified image").unwrap();
        assert!(matches!(
            download_image(&image, &destination, &crate::NoOpProgress).await,
            Err(Error::ChecksumMismatch { .. })
        ));
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"previous verified image"
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        request.assert_async().await;
    }

    #[tokio::test]
    async fn download_removes_unverified_partial_on_stream_error() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/image.xz", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let received = stream.read(&mut request).await.unwrap();
            assert!(received > 0);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial",
                )
                .await
                .unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("image.xz");
        let result = download_image(
            &image_for_data(&url, b"published"),
            &destination,
            &crate::NoOpProgress,
        )
        .await;
        assert!(matches!(result, Err(Error::Network(_))));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn download_removes_temporary_file_when_promotion_fails() {
        let data = b"published";
        let mut server = mockito::Server::new_async().await;
        let request = server
            .mock("GET", "/image.xz")
            .with_body(data)
            .create_async()
            .await;
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("image.xz");
        std::fs::create_dir(&destination).unwrap();
        let image = image_for_data(&format!("{}/image.xz", server.url()), data);
        assert!(matches!(
            download_image(&image, &destination, &crate::NoOpProgress).await,
            Err(Error::Io(_))
        ));
        assert!(destination.is_dir());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        request.assert_async().await;
    }

    #[test]
    fn release_metadata_preserves_unusable_digests_for_explicit_rejection() {
        for digest in [
            None,
            Some(serde_json::Value::Null),
            Some(serde_json::json!("sha256:bad")),
        ] {
            let mut asset = serde_json::json!({ "name": "haos_ova-18.3.qcow2.xz", "size": 100, "browser_download_url": "https://github.com/example.xz" });
            if let Some(digest) = digest {
                asset["digest"] = digest;
            }
            let release: GitHubRelease =
                serde_json::from_value(serde_json::json!({"tag_name": "18.3", "assets": [asset]}))
                    .unwrap();
            let release = parse_github_release(release).unwrap();
            assert!(
                expected_sha256(release.image_for("ova", ImageFormat::Qcow2).unwrap()).is_err()
            );
        }
    }

    #[tokio::test]
    async fn release_digest_survives_metadata_parsing_and_controls_download() {
        let data = b"published compressed bytes";
        let mut server = mockito::Server::new_async().await;
        let image = image_for_data(&format!("{}/image.xz", server.url()), data);
        let metadata = server.mock("GET", "/tags/18.3").with_header("content-type", "application/json").with_body(serde_json::json!({
            "tag_name": "18.3", "assets": [{ "name": "haos_ova-18.3.qcow2.xz", "size": data.len(), "browser_download_url": image.download_url, "digest": image.digest }]
        }).to_string()).create_async().await;
        let asset = server
            .mock("GET", "/image.xz")
            .with_body(data)
            .create_async()
            .await;
        let release = fetch_release_from_api(&server.url(), "18.3").await.unwrap();
        let selected = release.image_for("ova", ImageFormat::Qcow2).unwrap();
        assert_eq!(selected.digest, image.digest);
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("image.xz");
        std::fs::write(&destination, b"same name from a previous download").unwrap();
        download_image(selected, &destination, &crate::NoOpProgress)
            .await
            .unwrap();
        assert_eq!(std::fs::read(destination).unwrap(), data);
        metadata.assert_async().await;
        asset.assert_async().await;
    }

    fn stable_with(boards: &[(&str, &str)]) -> StableVersionInfo {
        serde_json::from_value(serde_json::json!({
            "hassos": boards
                .iter()
                .map(|(board, version)| (board.to_string(), version.to_string()))
                .collect::<std::collections::HashMap<_, _>>(),
        }))
        .expect("a stable.json with only hassos parses")
    }

    #[test]
    fn test_version_for_board_uses_that_boards_entry() {
        // A board held back during a staged rollout keeps its own version
        let stable = stable_with(&[("rpi5-64", "18.3"), ("odroid-n2", "18.2")]);

        assert_eq!(version_for_board(&stable, "odroid-n2").unwrap(), "18.2");
        assert_eq!(version_for_board(&stable, "rpi5-64").unwrap(), "18.3");
    }

    #[test]
    fn test_version_for_board_rejects_a_board_without_a_release() {
        let stable = stable_with(&[("rpi5-64", "18.3")]);

        match version_for_board(&stable, "tinker") {
            Err(Error::DownloadFailed(msg)) => assert!(msg.contains("tinker"), "{msg}"),
            other => panic!("Expected DownloadFailed, got {other:?}"),
        }
    }

    #[test]
    fn test_newest_version_compares_numerically() {
        let versions = ["9.5", "18.3", "18.10", "17.0"].map(String::from);
        assert_eq!(newest_version(versions.iter()).as_deref(), Some("18.10"));
        assert_eq!(newest_version([].iter()), None);
    }
    use crate::types::GitHubAsset;
    use serial_test::serial;

    #[tokio::test]
    async fn connection_check_reports_service_and_invalid_responses() {
        let mut server = mockito::Server::new_async().await;
        for (status, body, expected) in [
            (503, "", "service is unavailable (HTTP 503"),
            (200, "<html>Sign in</html>", "invalid response"),
            (200, r#"{"hassos":{"rpi5-64":"18.3"}}"#, ""),
        ] {
            let mock = server
                .mock("GET", "/stable.json")
                .with_status(status)
                .with_body(body)
                .create_async()
                .await;
            let result = check_connection_from_url(
                &format!("{}/stable.json", server.url()),
                METADATA_TIMEOUT,
            )
            .await;
            if expected.is_empty() {
                result.unwrap();
            } else {
                let error = result.unwrap_err().to_string();
                assert!(error.contains(expected), "{error}");
                assert!(!error.contains("No internet connection"));
            }
            mock.assert_async().await;
            mock.remove_async().await;
        }
    }

    async fn stalled_metadata_server(send_headers: bool) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/secret-not-for-display",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 1024];
            let _ = socket.read(&mut buffer).await;
            if send_headers {
                socket.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"
                ).await.unwrap();
            }
            tokio::time::sleep(METADATA_TIMEOUT * 2).await;
        });
        (url, server)
    }

    #[tokio::test]
    async fn connection_check_times_out_without_leaking_request_details() {
        for send_headers in [false, true] {
            let (url, server) = stalled_metadata_server(send_headers).await;
            let result = check_connection_from_url(&url, Duration::from_millis(250))
                .await
                .unwrap_err()
                .to_string();
            server.abort();
            let _ = server.await;
            assert!(
                result.contains("Check your internet connection"),
                "headers sent: {send_headers}, {result}"
            );
            assert!(!result.contains("invalid response"));
            assert!(!result.contains("secret"));
        }
    }

    #[tokio::test]
    async fn metadata_timeouts_do_not_leak_request_details() {
        let mut checks = Vec::new();
        for github in [false, true] {
            for send_headers in [false, true] {
                checks.push(tokio::spawn(async move {
                    let (url, server) = stalled_metadata_server(send_headers).await;
                    let error = if github {
                        fetch_release_from_api(&url, "18.3").await.unwrap_err()
                    } else {
                        get_stable_version_from_url(&url).await.unwrap_err()
                    };
                    server.abort();
                    let _ = server.await;
                    let expected = if github {
                        GITHUB_CONNECTION_FAILURE_MESSAGE
                    } else {
                        CONNECTION_FAILURE_MESSAGE
                    };
                    assert!(
                        matches!(&error, Error::DownloadFailed(message) if message == expected)
                    );
                    assert!(!error.to_string().contains("secret"));
                    assert!(!error.to_string().contains("127.0.0.1"));
                }));
            }
        }
        for check in checks {
            check.await.unwrap();
        }
    }

    #[tokio::test]
    async fn metadata_connect_failures_are_safe_but_parse_errors_are_unchanged() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/secret", listener.local_addr().unwrap());
        drop(listener);
        for github in [false, true] {
            let error = if github {
                fetch_release_from_api(&url, "18.3").await.unwrap_err()
            } else {
                get_stable_version_from_url(&url).await.unwrap_err()
            };
            let expected = if github {
                GITHUB_CONNECTION_FAILURE_MESSAGE
            } else {
                CONNECTION_FAILURE_MESSAGE
            };
            assert!(matches!(&error, Error::DownloadFailed(message) if message == expected));
            assert!(!error.to_string().contains("secret"));

            let mut server = mockito::Server::new_async().await;
            let path = if github { "/tags/18.3" } else { "/" };
            let response = server
                .mock("GET", path)
                .with_body("invalid json")
                .create_async()
                .await;
            let error = if github {
                fetch_release_from_api(&server.url(), "18.3")
                    .await
                    .unwrap_err()
            } else {
                get_stable_version_from_url(&server.url())
                    .await
                    .unwrap_err()
            };
            assert!(matches!(error, Error::Network(error) if error.is_decode()));
            response.assert_async().await;
        }
    }

    #[test]
    fn rate_limit_timing_uses_longest_applicable_header() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
        headers.insert("x-ratelimit-reset", "1120".parse().unwrap());
        headers.insert("retry-after", "180".parse().unwrap());
        assert_eq!(rate_limit_wait(&headers, 1000), 180);
        headers.insert("retry-after", "invalid".parse().unwrap());
        assert_eq!(rate_limit_wait(&headers, 1000), 120);
        assert_eq!(rate_limit_wait(&headers, 2000), 60);
        headers.insert("x-ratelimit-remaining", "42".parse().unwrap());
        assert_eq!(rate_limit_wait(&headers, 1000), 60);
        headers.insert("x-ratelimit-reset", "invalid".parse().unwrap());
        assert_eq!(rate_limit_wait(&headers, 1000), 60);
    }

    #[tokio::test]
    async fn release_rate_limits_and_forbidden_are_distinct() {
        let mut server = mockito::Server::new_async().await;
        for (status, remaining, body, expected) in [
            (403, "0", "{}", "request limit"),
            (429, "10", "not json", "request limit"),
            (
                403,
                "10",
                r#"{"message":"You have exceeded a secondary rate limit."}"#,
                "request limit",
            ),
            (
                403,
                "10",
                r#"{"message":"secret server detail"}"#,
                "refused access",
            ),
        ] {
            let mock = server
                .mock("GET", "/tags/18.3")
                .with_status(status)
                .with_header("x-ratelimit-remaining", remaining)
                .with_body(body)
                .create_async()
                .await;
            let error = fetch_release_from_api(&server.url(), "18.3")
                .await
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "{error}");
            assert!(!error.contains("secret server detail"));
            mock.assert_async().await;
            mock.remove_async().await;
        }
        let mock = server
            .mock("GET", "/tags/18.3")
            .with_status(403)
            .with_header("retry-after", "121")
            .create_async()
            .await;
        let error = fetch_release_from_api(&server.url(), "18.3")
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("3 minutes"));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn release_cache_reuses_success_per_version_and_retries_failures() {
        let mut server = mockito::Server::new_async().await;
        let cache = Mutex::new(HashMap::new());
        let failed = server
            .mock("GET", "/tags/18.3")
            .with_status(429)
            .expect(1)
            .create_async()
            .await;
        assert!(fetch_cached_release(&cache, &server.url(), "18.3")
            .await
            .is_err());
        failed.assert_async().await;
        failed.remove_async().await;
        for version in ["18.3", "18.4"] {
            let digest = format!("sha256:{}", "ab".repeat(32));
            let download_url = format!("https://example.com/haos_rpi5-64-{version}.img.xz");
            let mock = server
                .mock("GET", format!("/tags/{version}").as_str())
                .with_status(200)
                .with_body(
                    serde_json::json!({
                        "tag_name": version,
                        "assets": [{
                            "name": format!("haos_rpi5-64-{version}.img.xz"),
                            "size": 123,
                            "browser_download_url": download_url,
                            "digest": digest,
                        }],
                    })
                    .to_string(),
                )
                .expect(1)
                .create_async()
                .await;
            let url = server.url();
            let (first, second) = tokio::join!(
                fetch_cached_release(&cache, &url, version),
                fetch_cached_release(&cache, &url, version)
            );
            for release in [first.unwrap(), second.unwrap()] {
                assert_eq!(release.version, version);
                let image = release.image_for("rpi5-64", ImageFormat::Raw).unwrap();
                assert_eq!(image.download_url, download_url);
                assert_eq!(image.digest.as_deref(), Some(digest.as_str()));
            }
            mock.assert_async().await;
        }
    }

    #[test]
    fn temporary_images_are_isolated_and_live_until_last_owner() {
        let cache = tempfile::tempdir().unwrap();
        let first = TemporaryImage::new(cache.path(), ImageFormat::Qcow2).unwrap();
        let second = TemporaryImage::new(cache.path(), ImageFormat::Qcow2).unwrap();
        let path = first.path();
        std::fs::write(&path, b"first").unwrap();
        std::fs::write(second.path(), b"second").unwrap();
        let worker = first.clone();
        drop(first);
        assert!(path.exists());
        drop(worker);
        assert!(!path.exists());
        assert_eq!(std::fs::read(second.path()).unwrap(), b"second");
        let second_path = second.path();
        drop(second);
        assert!(!second_path.exists());
    }

    #[tokio::test]
    async fn failed_extraction_removes_owned_files() {
        let cache = tempfile::tempdir().unwrap();
        let image = TemporaryImage::new(cache.path(), ImageFormat::Raw).unwrap();
        let path = image.path();
        std::fs::write(image.archive_path(), b"not xz").unwrap();
        assert!(Backend
            .extract_temporary_image(&image, &crate::NoOpProgress)
            .await
            .is_err());
        drop(image);
        assert!(!path.exists());
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn cancelled_attempt_removes_owned_files() {
        let cache = tempfile::tempdir().unwrap();
        let image = TemporaryImage::new(cache.path(), ImageFormat::Raw).unwrap();
        let path = image.path();
        std::fs::write(&path, b"partial").unwrap();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _image = image;
            ready_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready_rx.await.unwrap();
        handle.abort();
        assert!(handle.await.unwrap_err().is_cancelled());
        assert!(!path.exists());
    }

    #[test]
    fn cleanup_removes_legacy_archives_and_preserves_unrecognized_files() {
        let cache = tempfile::tempdir().unwrap();
        let retained = [
            "haos_rpi5-64-18.0.rc1.img.xz",
            "haos_rpi5-64.img.xz",
            "user-image.qcow2",
            "unfinished.part",
            "haos_ova-17.0.qcow2",
        ];
        for name in retained.iter().chain(
            [
                "haos_rpi5-64-17.9.img.xz",
                "haos_rpi5-64-9.12.img.xz",
                "haos_generic-x86-64-16.0.qcow2.xz",
            ]
            .iter(),
        ) {
            std::fs::write(cache.path().join(name), b"archive").unwrap();
        }
        let active = TemporaryImage::new(cache.path(), ImageFormat::Raw).unwrap();
        std::fs::write(active.archive_path(), b"active").unwrap();
        prune_cached_images(cache.path()).unwrap();
        for name in retained {
            assert!(cache.path().join(name).exists(), "{name}");
        }
        assert!(!cache.path().join("haos_rpi5-64-17.9.img.xz").exists());
        assert!(!cache.path().join("haos_rpi5-64-9.12.img.xz").exists());
        assert!(!cache
            .path()
            .join("haos_generic-x86-64-16.0.qcow2.xz")
            .exists());
        assert!(active.archive_path().exists());
    }

    #[test]
    fn startup_reclaims_only_unlocked_owned_directories() {
        use std::io::Write;
        let cache = tempfile::tempdir().unwrap();
        let live = TemporaryImage::new(cache.path(), ImageFormat::Raw).unwrap();
        std::fs::write(live.path(), b"live").unwrap();
        let live_partial = live.archive_path().with_file_name(".tmp-live-partial");
        std::fs::write(&live_partial, b"partial").unwrap();
        let abandoned = cache.path().join("hai-image-1234567890123456");
        std::fs::create_dir(&abandoned).unwrap();
        std::fs::write(abandoned.join("image.img"), b"abandoned").unwrap();
        let abandoned_partial = abandoned.join(".tmp-abandoned-partial");
        std::fs::write(&abandoned_partial, b"partial").unwrap();
        let mut lock = std::fs::File::create(abandoned.join(".owner")).unwrap();
        lock.lock().unwrap();
        lock.write_all(IMAGE_OWNER_MARKER.as_bytes()).unwrap();
        let unowned = cache.path().join("hai-image-0000000000000000");
        std::fs::create_dir(&unowned).unwrap();
        std::fs::write(unowned.join(".owner"), b"not an installer image").unwrap();
        let importing = TemporaryImage::new(cache.path(), ImageFormat::Qcow2).unwrap();
        let retained_partial = importing
            .archive_path()
            .with_file_name(".tmp-retained-partial");
        std::fs::write(&retained_partial, b"partial").unwrap();
        importing.begin_utm_import().unwrap();
        drop(importing);
        prune_cached_images(cache.path()).unwrap();
        assert!(
            abandoned.exists(),
            "separately held lock must protect the directory"
        );
        assert!(live.path().exists());
        assert!(live_partial.exists());
        assert!(abandoned_partial.exists());
        assert!(retained_partial.exists());
        // Make the unlocked fixture independent of when all descriptors close.
        lock.unlock().unwrap();
        drop(lock);
        prune_cached_images(cache.path()).unwrap();
        assert!(!abandoned.exists());
        assert!(!abandoned_partial.exists());
        assert!(live.path().exists());
        assert!(live_partial.exists());
        assert!(retained_partial.exists());
        assert!(unowned.exists());
    }

    #[test]
    #[cfg(unix)]
    fn startup_does_not_follow_directory_or_marker_symlinks() {
        let cache = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join(".owner"), IMAGE_OWNER_MARKER).unwrap();
        std::os::unix::fs::symlink(
            outside.path(),
            cache.path().join("hai-image-1234567890123456"),
        )
        .unwrap();
        let linked_marker = cache.path().join("hai-image-0000000000000000");
        std::fs::create_dir(&linked_marker).unwrap();
        std::os::unix::fs::symlink(outside.path().join(".owner"), linked_marker.join(".owner"))
            .unwrap();
        prune_cached_images(cache.path()).unwrap();
        assert!(outside.path().join(".owner").exists());
        assert!(linked_marker.exists());
        assert!(cache.path().join("hai-image-1234567890123456").is_symlink());
    }

    #[test]
    #[cfg(unix)]
    fn failed_cleanup_retains_marker_for_startup_retry() {
        use std::os::unix::fs::PermissionsExt;
        let cache = tempfile::tempdir().unwrap();
        let image = TemporaryImage::new(cache.path(), ImageFormat::Raw).unwrap();
        // Hold the owner lock explicitly so each retry sees a known lock state.
        let lock = image.directory.lock.as_ref().unwrap().try_clone().unwrap();
        let directory = image.path().parent().unwrap().to_path_buf();
        let blocked = directory.join("blocked");
        std::fs::create_dir(&blocked).unwrap();
        std::fs::write(blocked.join("image"), b"data").unwrap();
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o0)).unwrap();
        drop(image);
        // Observe the failed removal itself: opening ReadDir can succeed even
        // when reading or removing entries is denied. Root may remove it all.
        if directory.exists() {
            assert!(directory.join(".owner").exists());
            std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o700)).unwrap();
            prune_cached_images(cache.path()).unwrap();
            assert!(directory.exists(), "the shared lock must prevent recovery");
            assert_eq!(std::fs::read(blocked.join("image")).unwrap(), b"data");
            lock.unlock().unwrap();
            prune_cached_images(cache.path()).unwrap();
        }
        assert!(!directory.exists());
    }

    #[test]
    fn test_get_cache_dir() {
        let result = get_cache_dir();
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_get_device_manifest_filters_runtime_boards_preserving_display_data() {
        let mut server = mockito::Server::new_async().await;
        let request = server
            .mock("GET", "/stable.json")
            .with_header("content-type", "application/json")
            .with_body(r#"{"hassos":{"rpi5-64":"18.3","odroid-n2":"18.2","future-board":"18.3"}}"#)
            .create_async()
            .await;
        let manifest = get_device_manifest_from_url(&format!("{}/stable.json", server.url()))
            .await
            .unwrap();
        let bundled = crate::manifest::bundled_manifest();
        assert_eq!(manifest.version, bundled.version);
        let expected: Vec<_> = bundled
            .devices
            .into_iter()
            .filter(|device| ["rpi5-64", "odroid-n2"].contains(&device.haos.board.as_str()))
            .collect();
        assert_eq!(
            serde_json::to_value(manifest.devices).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        request.assert_async().await;
    }

    #[tokio::test]
    async fn test_get_device_manifest_empty_runtime_catalog() {
        let mut server = mockito::Server::new_async().await;
        let request = server
            .mock("GET", "/stable.json")
            .with_header("content-type", "application/json")
            .with_body(r#"{"hassos":{}}"#)
            .create_async()
            .await;
        let manifest = get_device_manifest_from_url(&format!("{}/stable.json", server.url()))
            .await
            .unwrap();
        assert!(manifest.devices.is_empty());
        request.assert_async().await;
    }

    #[tokio::test]
    async fn test_get_device_manifest_bounds_stalled_headers_and_body() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for send_headers in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/stable.json", listener.local_addr().unwrap());
            let (started, received) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 1];
                stream.read_exact(&mut request).await.unwrap();
                if send_headers {
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{").await.unwrap();
                }
                started.send(()).unwrap();
                std::future::pending::<()>().await;
            });
            let lookup = tokio::spawn(async move {
                get_device_manifest_with_timeout(&url, std::time::Duration::from_secs(1)).await
            });
            let error = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                received.await.unwrap();
                lookup.await.unwrap().unwrap_err()
            })
            .await
            .expect("catalog request must have a total deadline");
            server.abort();
            let _ = server.await;
            assert!(error
                .to_string()
                .contains("Timed out fetching device availability"));
        }
    }

    #[tokio::test]
    async fn test_get_device_manifest_does_not_fall_back_after_fetch_failure() {
        let mut server = mockito::Server::new_async().await;
        for (status, body) in [(503, "unavailable"), (200, r#"{"hassos":null}"#)] {
            let request = server
                .mock("GET", "/stable.json")
                .with_status(status)
                .with_header("content-type", "application/json")
                .with_body(body)
                .create_async()
                .await;
            assert!(
                get_device_manifest_from_url(&format!("{}/stable.json", server.url()))
                    .await
                    .is_err()
            );
            request.assert_async().await;
        }
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
        let result =
            parse_board_from_filename_with_suffix("haos_ova-14.2.qcow2.xz", "14.2", ".qcow2.xz");
        assert_eq!(result.unwrap(), "ova");

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
    fn test_parse_github_release() {
        let release = GitHubRelease {
            tag_name: "14.2".to_string(),
            assets: vec![
                GitHubAsset {
                    name: "haos_rpi5-64-14.2.img.xz".to_string(),
                    digest: None,
                    size: 500_000_000,
                    browser_download_url: "https://github.com/download/rpi5.img.xz".to_string(),
                },
                GitHubAsset {
                    name: "haos_ova-14.2.qcow2.xz".to_string(),
                    digest: None,
                    size: 600_000_000,
                    browser_download_url: "https://github.com/download/x86.qcow2.xz".to_string(),
                },
                // Should be ignored (wrong extension)
                GitHubAsset {
                    name: "haos_rpi5-64-14.2.img.xz.sha256".to_string(),
                    digest: None,
                    size: 100,
                    browser_download_url: "https://github.com/download/sha256".to_string(),
                },
            ],
        };

        let parsed = parse_github_release(release).unwrap();
        assert_eq!(parsed.version, "14.2");
        assert_eq!(parsed.images.len(), 2);

        // Check rpi5-64 image
        let rpi_image = parsed.images.iter().find(|i| i.board == "rpi5-64").unwrap();
        assert_eq!(rpi_image.format, ImageFormat::Raw);
        assert_eq!(rpi_image.size, 500_000_000);

        // Check x86 qcow2 image
        let x86_image = parsed.images.iter().find(|i| i.board == "ova").unwrap();
        assert_eq!(x86_image.format, ImageFormat::Qcow2);
        assert_eq!(x86_image.size, 600_000_000);
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

    #[tokio::test]
    #[serial]
    async fn test_download_image_http_404_error() {
        let test_data = b"";
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("GET", "/test.img.xz")
            .with_status(404)
            .create_async()
            .await;

        let url = format!("{}/test.img.xz", server.url());
        let cache_dir = get_cache_dir().unwrap();
        let dest = cache_dir.join("test_404.img");

        let result = download_image(
            &image_for_data(&url, test_data.as_ref()),
            &dest,
            &crate::NoOpProgress,
        )
        .await;
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
        let test_data = b"";
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

        let result = download_image(
            &image_for_data(&url, test_data.as_ref()),
            &dest,
            &crate::NoOpProgress,
        )
        .await;
        assert!(result.is_err());

        mock.assert_async().await;
        let _ = std::fs::remove_file(&dest);
    }

    #[tokio::test]
    #[serial]
    async fn test_download_image_success_with_checksum() {
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

        let result = download_image(
            &image_for_data(&url, test_data.as_ref()),
            &dest,
            &crate::NoOpProgress,
        )
        .await;
        assert!(result.is_ok());

        // Verify file was created and has correct content
        let content = std::fs::read(&dest).unwrap();
        assert_eq!(content, test_data);

        mock.assert_async().await;
        std::fs::remove_file(&dest).unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn test_download_image_with_progress_updates() {
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

        let result =
            download_image(&image_for_data(&url, test_data.as_ref()), &dest, &callback).await;
        assert!(result.is_ok());
        mock.assert_async().await;

        // Check that we got progress callbacks
        let progress_calls = calls.lock().unwrap();
        assert!(!progress_calls.is_empty());
        assert!(progress_calls.iter().any(|p| p.progress == 0)); // Start
        assert!(progress_calls.iter().any(|p| p.progress == 100)); // End
        assert!(progress_calls
            .iter()
            .all(|p| p.stage == FlashStage::Downloading));

        std::fs::remove_file(&dest).unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn test_download_image_no_content_length() {
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

        let result = download_image(
            &image_for_data(&url, test_data.as_ref()),
            &dest,
            &crate::NoOpProgress,
        )
        .await;
        assert!(result.is_ok());

        mock.assert_async().await;
        std::fs::remove_file(&dest).unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn test_extract_xz_real_file() {
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
        let cache_dir = get_cache_dir().unwrap();
        let archive_path = cache_dir.join("nonexistent_archive.xz");
        let dest_path = cache_dir.join("output.img");

        let result = extract_xz(&archive_path, &dest_path, &crate::NoOpProgress).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    #[serial]
    async fn test_extract_xz_corrupt_archive_is_discarded() {
        use std::io::Write;

        let cache_dir = get_cache_dir().unwrap();
        let archive_path = cache_dir.join("test_corrupt.img.xz");
        let extracted_path = cache_dir.join("test_corrupt_extracted.img");

        // Write a valid xz stream, then truncate its tail so the container's
        // integrity check fails part-way through decoding.
        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let mut encoder = xz2::write::XzEncoder::new(file, 1);
            encoder.write_all(&vec![0u8; 256 * 1024]).unwrap();
            encoder.finish().unwrap();
        }
        let mut bytes = std::fs::read(&archive_path).unwrap();
        bytes.truncate(bytes.len() - 16);
        std::fs::write(&archive_path, &bytes).unwrap();

        let result = extract_xz(&archive_path, &extracted_path, &crate::NoOpProgress).await;
        assert!(matches!(result, Err(Error::ExtractionFailed(_))));

        // A corrupt archive leaves neither the archive nor extracted output.
        assert!(!archive_path.exists());
        assert!(!extracted_path.exists());
    }

    #[tokio::test]
    async fn test_extract_xz_with_progress() {
        use std::io::Write;
        use std::sync::Mutex;

        struct TestProgressCallback {
            calls: Mutex<Vec<FlashProgress>>,
            destination: PathBuf,
            expected: Vec<u8>,
        }

        impl crate::ProgressCallback for TestProgressCallback {
            fn on_progress(&self, progress: FlashProgress) {
                if progress.progress == 100 {
                    assert_eq!(std::fs::read(&self.destination).unwrap(), self.expected);
                }
                self.calls.lock().unwrap().push(progress);
            }
        }

        let mut seed = 1u32;
        let incompressible: Vec<u8> = (0..256 * 1024)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                seed as u8
            })
            .collect();
        for content in [
            Vec::new(),
            b"tiny".to_vec(),
            vec![0u8; 11 * 1024 * 1024],
            incompressible,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let archive_path = directory.path().join("image.xz");
            let mut encoder = xz2::write::XzEncoder::new(Vec::new(), 1);
            encoder.write_all(&content).unwrap();
            let archive = encoder.finish().unwrap();
            std::fs::write(&archive_path, &archive).unwrap();
            let callback = TestProgressCallback {
                calls: Mutex::new(Vec::new()),
                destination: directory.path().join("image.img"),
                expected: content,
            };

            extract_xz(&archive_path, &callback.destination, &callback)
                .await
                .unwrap();

            let calls = callback.calls.lock().unwrap();
            assert_eq!(calls.first().unwrap().progress, 0);
            assert_eq!(calls.last().unwrap().progress, 100);
            assert_eq!(calls.last().unwrap().bytes_processed, archive.len() as u64);
            assert!(calls[..calls.len() - 1].iter().all(|p| p.progress < 100));
            assert!(calls.iter().all(|p| {
                p.stage == FlashStage::Extracting
                    && p.total_bytes == archive.len() as u64
                    && p.bytes_processed <= p.total_bytes
            }));
            assert!(calls.windows(2).all(|pair| {
                pair[0].progress <= pair[1].progress
                    && pair[0].bytes_processed <= pair[1].bytes_processed
            }));
            if callback.expected.len() > 64 * 1024 {
                assert!(calls.iter().any(|p| p.progress > 0 && p.progress < 99));
            }
        }
    }

    #[tokio::test]
    async fn test_extract_xz_failure_never_reports_complete() {
        use std::io::Write;
        use std::sync::Mutex;

        #[derive(Default)]
        struct Progress(Mutex<Vec<FlashProgress>>);
        impl crate::ProgressCallback for Progress {
            fn on_progress(&self, progress: FlashProgress) {
                self.0.lock().unwrap().push(progress);
            }
        }

        for failure in ["truncated", "empty", "destination"] {
            let directory = tempfile::tempdir().unwrap();
            let archive_path = directory.path().join("image.xz");
            let destination = directory.path().join("image.img");
            let mut encoder = xz2::write::XzEncoder::new(Vec::new(), 1);
            encoder.write_all(&vec![0u8; 256 * 1024]).unwrap();
            let mut archive = encoder.finish().unwrap();
            if failure == "truncated" {
                archive.truncate(archive.len() - 16);
            } else if failure == "empty" {
                archive.clear();
            } else {
                std::fs::create_dir(&destination).unwrap();
            }
            std::fs::write(&archive_path, &archive).unwrap();
            let callback = Progress::default();
            assert!(extract_xz(&archive_path, &destination, &callback)
                .await
                .is_err());
            assert!(callback.0.lock().unwrap().iter().all(|p| p.progress < 100));
            if failure != "destination" {
                assert!(!archive_path.exists());
                assert!(!destination.exists());
            } else {
                assert!(archive_path.exists());
                assert!(destination.is_dir());
            }
        }
    }

    #[tokio::test]
    async fn test_parse_github_release_invalid_filename_skipped() {
        use crate::types::{GitHubAsset, GitHubRelease};

        let release = GitHubRelease {
            tag_name: "14.2".to_string(),
            assets: vec![GitHubAsset {
                name: "invalid_filename.img.xz".to_string(), // Doesn't match pattern
                digest: None,
                size: 500_000_000,
                browser_download_url: "https://github.com/download/invalid.img.xz".to_string(),
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

    // HTTP Mock Tests Module
    // These tests use mockito to mock external HTTP endpoints
    mod http_mock_tests {
        use super::*;

        #[tokio::test]
        #[serial]
        async fn test_get_stable_version_success() {
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/stable.json")
                .match_header("User-Agent", USER_AGENT)
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
            let mut server = mockito::Server::new_async().await;

            let mock = server
                .mock("GET", "/tags/14.2")
                .match_header("User-Agent", USER_AGENT)
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
                            "name": "haos_ova-14.2.qcow2.xz",
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
            assert!(release.images.iter().any(|i| i.board == "ova"));

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_release_http_404() {
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
        async fn test_download_image_empty_response() {
            let test_data = b"";
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

            let result = download_image(
                &image_for_data(&url, test_data.as_ref()),
                &dest,
                &crate::NoOpProgress,
            )
            .await;
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

            let result = download_image(
                &image_for_data(&url, test_data.as_ref()),
                &dest,
                &crate::NoOpProgress,
            )
            .await;
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
                            "name": "haos_ova-14.2.qcow2.xz",
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
            assert_eq!(release.images[0].board, "ova");
            assert!(release.images[0].download_url.contains("qcow2"));

            mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_fetch_release_connection_refused() {
            // Use a port that's likely not in use
            let result = fetch_release_from_api("http://127.0.0.1:59999", "14.2").await;
            assert!(result.is_err());
        }

        #[tokio::test]
        #[serial]
        async fn test_get_stable_version_connection_refused() {
            let result = get_stable_version_from_url("http://127.0.0.1:59998/stable.json").await;
            assert!(result.is_err());
        }
    }
}
