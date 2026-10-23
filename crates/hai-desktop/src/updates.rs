//! Updates of the installer itself, from its GitHub releases.
//!
//! Each release carries a `latest.json` for the Tauri updater, which lists
//! the signed update of every platform. Which release to update to depends on
//! the channel of the running version: an alpha takes the newest release of
//! any channel, a beta the newest beta or stable release, and a stable release
//! only stable releases. GitHub's link to the latest release only ever leads
//! to a stable one, so the release tags are listed through its API instead.
//!
//! Updating takes three steps, so the frontend decides when the app restarts:
//! `download_update`, `install_update` and `restart_after_update`.

use crate::close_guard::job_running;
use crate::command_error::CommandError;
use crate::diagnostics::Operation;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Every tag, on one page. A release only gets its tag when it's published,
/// so drafts are left out, and only names come back, not whole releases.
const TAGS_API: &str =
    "https://api.github.com/repos/home-assistant/installer/git/matching-refs/tags/";
const RELEASES: &str = "https://github.com/home-assistant/installer/releases";
const USER_AGENT: &str = concat!("HomeAssistantInstaller/", env!("CARGO_PKG_VERSION"));
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Between two reads, so a download of any size can take its time, but a
/// stalled one fails.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// How many releases to try, newest first, when one has no update for this
/// platform, like a release made by hand.
const CANDIDATES: usize = 3;

/// The update the last check found, until the app restarts into it.
#[derive(Default)]
pub struct PendingUpdate {
    update: Mutex<Option<Update>>,
    /// Downloaded and verified, until it is installed
    bytes: Mutex<Option<Vec<u8>>>,
    installed: AtomicBool,
}

impl PendingUpdate {
    fn update(&self) -> Option<Update> {
        lock(&self.update).clone()
    }
}

/// A single replace or take can't leave the value half-changed after a panic.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// A newer version the installer can update itself to.
#[derive(Debug, Serialize, PartialEq)]
pub struct AvailableUpdate {
    pub version: String,
    /// The release's page, to download it by hand.
    pub release_url: String,
    /// Whether the app can replace itself, which it can't from a read-only
    /// volume such as the DMG, or where macOS translocated it to.
    pub installable: bool,
}

/// How far downloading the update got.
#[derive(Clone, Serialize)]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

#[derive(Deserialize)]
struct Ref {
    #[serde(rename = "ref")]
    name: String,
}

/// Look for a newer release on the channel of the running version, and keep
/// it for `download_update`. Resolves to `None` when there is none.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<AvailableUpdate>, CommandError> {
    let operation = Operation::new("update_check");
    let result = check(&app, &pending).await;
    operation.finish(result)
}

async fn check(
    app: &AppHandle,
    pending: &PendingUpdate,
) -> Result<Option<AvailableUpdate>, CommandError> {
    *lock(&pending.update) = None;
    *lock(&pending.bytes) = None;
    pending.installed.store(false, Ordering::Release);
    let current = &app.package_info().version;
    // Only release runs set the version; any other build has nothing to
    // update to and must not replace itself with a release
    if *current == Version::new(0, 0, 0) {
        return Ok(None);
    }

    let tags = fetch_tags(TAGS_API).await?;
    let mut failed = false;
    for version in update_candidates(current, &tags).iter().take(CANDIDATES) {
        let Ok(Some(update)) = fetch_update(app, version).await else {
            failed = true;
            continue;
        };
        let available = AvailableUpdate {
            version: update.version.clone(),
            release_url: format!("{RELEASES}/tag/{version}"),
            installable: installable(),
        };
        *lock(&pending.update) = Some(update);
        return Ok(Some(available));
    }
    if failed {
        return Err(check_failed());
    }
    Ok(None)
}

/// The update `latest.json` of the release `version` describes.
async fn fetch_update(
    app: &AppHandle,
    version: &Version,
) -> tauri_plugin_updater::Result<Option<Update>> {
    let manifest = Url::parse(&format!("{RELEASES}/download/{version}/latest.json"))
        .map_err(|error| tauri_plugin_updater::Error::Network(error.to_string()))?;
    app.updater_builder()
        .endpoints(vec![manifest])?
        // For the download too, which has no timeout of its own
        .configure_client(|client| {
            client
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(READ_TIMEOUT)
        })
        .build()?
        .check()
        .await
}

/// The repository's tags, as GitHub lists them.
async fn fetch_tags(tags_api: &str) -> Result<Vec<String>, CommandError> {
    let response = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        // Tests serve the list from a plain-HTTP mock server
        .https_only(!cfg!(test))
        .build()
        .map_err(|_| check_failed())?
        .get(tags_api)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| check_failed())?;
    if !response.status().is_success() {
        return Err(check_failed());
    }
    let refs: Vec<Ref> = response.json().await.map_err(|_| check_failed())?;
    Ok(refs
        .into_iter()
        .filter_map(|tag| tag.name.strip_prefix("refs/tags/").map(str::to_owned))
        .collect())
}

/// The released versions newer than `current`, on its channel or a more
/// stable one, newest first.
fn update_candidates(current: &Version, tags: &[String]) -> Vec<Version> {
    let mut candidates: Vec<_> = tags
        .iter()
        .filter_map(|tag| Version::parse(tag).ok())
        .filter(|version| stability(version) >= stability(current) && version > current)
        .collect();
    candidates.sort_unstable_by(|a, b| b.cmp(a));
    candidates
}

/// Stable releases are the most stable, then betas, then alphas. Any other
/// prerelease counts as an alpha, so it only reaches alphas.
fn stability(version: &Version) -> u8 {
    match version.pre.split('.').next() {
        Some("") => 2,
        Some("beta") => 1,
        _ => 0,
    }
}

/// Whether the updater can replace the running app: not on macOS when the
/// app runs from a read-only volume, like the mounted DMG, or a translocated
/// copy macOS runs a downloaded app from until it is moved.
fn installable() -> bool {
    #[cfg(target_os = "macos")]
    {
        let bundle = tauri::utils::platform::current_exe()
            .ok()
            .and_then(|exe| tauri_plugin_updater::extract_path_from_executable(&exe).ok());
        if let Some(bundle) = bundle {
            return !read_only_volume(&bundle);
        }
    }
    true
}

#[cfg(target_os = "macos")]
fn read_only_volume(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `path` is NUL-terminated, and `stat` is only read after
    // `statfs` succeeded, which fills it.
    unsafe {
        libc::statfs(path.as_ptr(), stat.as_mut_ptr()) == 0
            && stat.assume_init().f_flags & libc::MNT_RDONLY as u32 != 0
    }
}

fn check_failed() -> CommandError {
    CommandError::new("network", "Could not check for updates.", true)
        .with_diagnostic("update_check_failed")
}

/// Download the update the last check found, and verify its signature.
#[tauri::command]
pub async fn download_update(
    pending: State<'_, PendingUpdate>,
    progress: Channel<UpdateProgress>,
) -> Result<(), CommandError> {
    let operation = Operation::new("update_download");
    let result = download(&pending, &progress).await;
    operation.finish(result)
}

async fn download(
    pending: &PendingUpdate,
    progress: &Channel<UpdateProgress>,
) -> Result<(), CommandError> {
    let update = pending.update().ok_or_else(no_update)?;
    let downloaded = AtomicU64::new(0);
    let mut next_report = 0;
    let bytes = update
        .download(
            |chunk, total| {
                let downloaded =
                    downloaded.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                // Every chunk would flood the channel: report each percent,
                // or each MiB while the size is unknown
                if downloaded >= next_report {
                    next_report = downloaded + total.map_or(1 << 20, |total| total / 100);
                    let _ = progress.send(UpdateProgress { downloaded, total });
                }
            },
            || {
                // All of it, which the last percent may not have reported
                let downloaded = downloaded.load(Ordering::Relaxed);
                let _ = progress.send(UpdateProgress {
                    downloaded,
                    total: Some(downloaded),
                });
            },
        )
        .await
        .map_err(|_| update_failed().with_diagnostic("update_download_failed"))?;
    *lock(&pending.bytes) = Some(bytes);
    Ok(())
}

/// Install the downloaded update. Refused while an installation runs. On
/// Windows the installer takes over and the app exits; elsewhere the update
/// starts with `restart_after_update`. Installing again does nothing.
#[tauri::command]
pub async fn install_update(pending: State<'_, PendingUpdate>) -> Result<(), CommandError> {
    if pending.installed.load(Ordering::Acquire) {
        return Ok(());
    }
    refuse_while_installing()?;
    let operation = Operation::new("update_install");
    let result = install(&pending).await;
    operation.finish(result)?;
    pending.installed.store(true, Ordering::Release);
    Ok(())
}

async fn install(pending: &PendingUpdate) -> Result<(), CommandError> {
    let update = pending.update().ok_or_else(no_update)?;
    let bytes = lock(&pending.bytes).take().ok_or_else(no_update)?;
    // Blocks, on Linux and macOS until the user answers a password prompt
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| update_failed().with_diagnostic("update_install_failed"))
}

/// Start the installed update. Refused while an installation runs, which the
/// restart would cut short: one may have started while the install waited
/// for a password.
#[tauri::command]
pub fn restart_after_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), CommandError> {
    if !pending.installed.load(Ordering::Acquire) {
        return Err(no_update());
    }
    refuse_while_installing()?;
    app.request_restart();
    Ok(())
}

fn refuse_while_installing() -> Result<(), CommandError> {
    if job_running() {
        return Err(CommandError::new(
            "operation_in_progress",
            "Finish the installation before updating the installer.",
            true,
        ));
    }
    Ok(())
}

fn no_update() -> CommandError {
    CommandError::new("update_failed", "There is no update to install.", false)
}

fn update_failed() -> CommandError {
    CommandError::new("update_failed", "The update could not be installed.", true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn newest(current: &str, tags: &[&str]) -> Option<String> {
        let tags: Vec<_> = tags.iter().map(|tag| tag.to_string()).collect();
        update_candidates(&Version::parse(current).unwrap(), &tags)
            .first()
            .map(|version| version.to_string())
    }

    #[test]
    fn alphas_take_the_newest_release_of_any_channel() {
        assert_eq!(
            newest("0.0.0-alpha.3", &["0.0.0-alpha.4", "0.0.0-alpha.2"]).as_deref(),
            Some("0.0.0-alpha.4")
        );
        assert_eq!(
            newest("0.0.0-alpha.3", &["0.0.0-alpha.4", "0.0.0-beta.1"]).as_deref(),
            Some("0.0.0-beta.1")
        );
        assert_eq!(
            newest("2026.11.0-alpha.1", &["2026.11.0", "2026.11.0-beta.2"]).as_deref(),
            Some("2026.11.0")
        );
    }

    #[test]
    fn betas_skip_alphas() {
        assert_eq!(
            newest(
                "2026.11.0-beta.1",
                &["2026.12.0-alpha.1", "2026.11.0-beta.2"]
            )
            .as_deref(),
            Some("2026.11.0-beta.2")
        );
        assert_eq!(newest("2026.11.0-beta.1", &["2026.12.0-alpha.1"]), None);
    }

    #[test]
    fn stable_releases_only_take_stable_releases() {
        assert_eq!(
            newest(
                "2026.11.0",
                &["2026.12.0-beta.1", "2026.11.1", "2026.11.2-alpha.1"]
            )
            .as_deref(),
            Some("2026.11.1")
        );
        assert_eq!(newest("2026.11.0", &["2026.12.0-beta.1"]), None);
    }

    #[test]
    fn never_offers_the_running_version_or_an_older_one() {
        assert_eq!(newest("2026.11.1", &["2026.11.1", "2026.11.0"]), None);
        assert_eq!(newest("0.0.0-beta.1", &["0.0.0-alpha.9"]), None);
    }

    #[test]
    fn tries_the_newest_releases_first() {
        let tags: Vec<_> = [
            "2026.11.1",
            "nightly",
            "2026.12.0",
            "v2026.12.1",
            "2026.11.0",
        ]
        .iter()
        .map(|tag| tag.to_string())
        .collect();
        let candidates = update_candidates(&Version::parse("2026.11.0").unwrap(), &tags);
        assert_eq!(
            candidates,
            [Version::new(2026, 12, 0), Version::new(2026, 11, 1)]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn tells_read_only_volumes_apart() {
        // The system volume is sealed, read-only, since macOS 11
        assert!(read_only_volume(std::path::Path::new("/System")));
        assert!(!read_only_volume(&std::env::temp_dir()));
    }

    /// The shape `scripts/updater-manifest.mjs` writes: the updater looks up
    /// `{os}-{arch}-{bundle type}`.
    #[test]
    fn reads_the_manifest_the_release_job_writes() {
        let entry = |name: &str| {
            serde_json::json!({
                "signature": format!("signature of {name}"),
                "url": format!("{RELEASES}/download/2026.11.0/{name}"),
            })
        };
        let release: tauri_plugin_updater::RemoteRelease =
            serde_json::from_value(serde_json::json!({
                "version": "2026.11.0",
                "pub_date": "2026-11-20T12:00:00.000Z",
                "platforms": {
                    "darwin-aarch64-app": entry("Home.Assistant.Installer.app.tar.gz"),
                    "darwin-x86_64-app": entry("Home.Assistant.Installer.app.tar.gz"),
                    "windows-x86_64-nsis": entry("setup.exe"),
                    "linux-x86_64-deb": entry("amd64.deb"),
                    "linux-x86_64-rpm": entry("x86_64.rpm"),
                    "linux-x86_64-appimage": entry("amd64.AppImage"),
                },
            }))
            .unwrap();
        assert_eq!(release.version, Version::new(2026, 11, 0));
        assert_eq!(
            release.download_url("linux-x86_64-rpm").unwrap().as_str(),
            format!("{RELEASES}/download/2026.11.0/x86_64.rpm")
        );
        assert_eq!(
            release.signature("darwin-aarch64-app").unwrap(),
            "signature of Home.Assistant.Installer.app.tar.gz"
        );
    }

    #[tokio::test]
    async fn lists_the_tags_from_the_github_api() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/tags/")
            .match_header("User-Agent", USER_AGENT)
            .match_header("Accept", "application/vnd.github+json")
            .with_body(
                r#"[{"ref": "refs/tags/0.0.0-alpha.3", "object": {"type": "commit"}},
                    {"ref": "refs/tags/0.0.0-alpha.4", "object": {"type": "commit"}}]"#,
            )
            .create_async()
            .await;

        let tags = fetch_tags(&format!("{}/tags/", server.url()))
            .await
            .unwrap();
        mock.assert_async().await;
        assert_eq!(tags, ["0.0.0-alpha.3", "0.0.0-alpha.4"]);
    }

    #[tokio::test]
    async fn a_failed_listing_is_a_failed_check() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/tags/")
            .with_status(403)
            .with_body(r#"{"message": "API rate limit exceeded"}"#)
            .create_async()
            .await;

        let error = fetch_tags(&format!("{}/tags/", server.url()))
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "network");
        assert_eq!(error.diagnostic, "update_check_failed");
    }
}
