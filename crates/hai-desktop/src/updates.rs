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

use crate::close_guard::{jobs, JobCounter, UpdateHold};
use crate::command_error::CommandError;
use crate::diagnostics::Operation;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State, Url};
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
    source: Source,
    update: Mutex<Option<Update>>,
    steps: UpdateSteps,
}

/// Where the check looks for releases: GitHub, but a test's own server.
struct Source {
    tags_api: String,
    releases: String,
}

impl Default for Source {
    fn default() -> Self {
        Self {
            tags_api: TAGS_API.to_owned(),
            releases: RELEASES.to_owned(),
        }
    }
}

impl PendingUpdate {
    fn update(&self) -> Option<Update> {
        lock(&self.update).clone()
    }
}

/// How far updating got, apart from the updater, which installs and
/// restarts through the functions it's given.
struct UpdateSteps {
    jobs: &'static JobCounter,
    /// Downloaded and verified, until it is installed
    bytes: Mutex<Option<Vec<u8>>>,
    installed: AtomicBool,
    /// Taken by the restart and kept until the app exits, so no job starts
    /// that the restart would cut short
    restart_hold: Mutex<Option<UpdateHold>>,
}

impl Default for UpdateSteps {
    fn default() -> Self {
        Self::new(jobs())
    }
}

impl UpdateSteps {
    fn new(jobs: &'static JobCounter) -> Self {
        Self {
            jobs,
            bytes: Mutex::default(),
            installed: AtomicBool::new(false),
            restart_hold: Mutex::default(),
        }
    }

    /// Forget the last update, for another check.
    fn reset(&self) {
        *lock(&self.bytes) = None;
        self.installed.store(false, Ordering::Release);
    }

    fn downloaded(&self, bytes: Vec<u8>) {
        *lock(&self.bytes) = Some(bytes);
    }

    /// Install the downloaded update with `run`, which says whether that
    /// worked. Refused while a job runs, and no job starts until it's done.
    /// A failed install keeps the update for another try, and once one
    /// worked, installing again does nothing.
    async fn install(
        &self,
        run: impl FnOnce(&[u8]) -> bool + Send + 'static,
    ) -> Result<(), CommandError> {
        if self.installed.load(Ordering::Acquire) {
            return Ok(());
        }
        let _hold = self
            .jobs
            .hold_for_update()
            .ok_or_else(installation_running)?;
        let bytes = lock(&self.bytes).take().ok_or_else(no_update)?;
        // Blocks, on Linux and macOS until the user answers a password prompt
        let (bytes, installed) = tauri::async_runtime::spawn_blocking(move || {
            let installed = run(&bytes);
            (bytes, installed)
        })
        .await
        .map_err(|_| install_failed())?;
        if !installed {
            *lock(&self.bytes) = Some(bytes);
            return Err(install_failed());
        }
        self.installed.store(true, Ordering::Release);
        Ok(())
    }

    /// Start the installed update with `request`. Refused while a job runs,
    /// which the restart would cut short: one may have started while the
    /// install waited for a password. From then on no job starts, even if
    /// the restart is asked for again.
    fn restart(&self, request: impl FnOnce()) -> Result<(), CommandError> {
        if !self.installed.load(Ordering::Acquire) {
            return Err(no_update());
        }
        let mut hold = lock(&self.restart_hold);
        if hold.is_none() {
            *hold = Some(
                self.jobs
                    .hold_for_update()
                    .ok_or_else(installation_running)?,
            );
        }
        request();
        Ok(())
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
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// Which of a download's chunks to report: every chunk would flood the
/// channel, so one for each percent, or each MiB while the size is unknown.
#[derive(Default)]
struct ProgressReports {
    downloaded: u64,
    next: u64,
}

impl ProgressReports {
    fn chunk(&mut self, length: usize, total: Option<u64>) -> Option<UpdateProgress> {
        self.downloaded += length as u64;
        if self.downloaded < self.next {
            return None;
        }
        self.next = self.downloaded + total.map_or(1 << 20, |total| total / 100);
        Some(UpdateProgress {
            downloaded: self.downloaded,
            total,
        })
    }

    /// All of it, which the last report may not have covered.
    fn finished(&self) -> UpdateProgress {
        UpdateProgress {
            downloaded: self.downloaded,
            total: Some(self.downloaded),
        }
    }
}

#[derive(Deserialize)]
struct Ref {
    #[serde(rename = "ref")]
    name: String,
}

/// Look for a newer release on the channel of the running version, and keep
/// it for `download_update`. Resolves to `None` when there is none.
#[tauri::command]
pub async fn check_for_update<R: Runtime>(
    app: AppHandle<R>,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<AvailableUpdate>, CommandError> {
    let operation = Operation::new("update_check");
    let result = check(&app, &pending).await;
    operation.finish(result)
}

async fn check<R: Runtime>(
    app: &AppHandle<R>,
    pending: &PendingUpdate,
) -> Result<Option<AvailableUpdate>, CommandError> {
    let Source { tags_api, releases } = &pending.source;
    *lock(&pending.update) = None;
    pending.steps.reset();
    let current = &app.package_info().version;
    // Only release runs set the version; any other build has nothing to
    // update to and must not replace itself with a release
    if *current == Version::new(0, 0, 0) {
        return Ok(None);
    }

    let tags = fetch_tags(tags_api).await?;
    let candidates = update_candidates(current, &tags);
    let found = first_update(
        &candidates,
        |update: &Update| &update.version,
        |tag| async move { fetch_update(app, releases, &tag).await.ok().flatten() },
    )
    .await?;
    let Some((tag, update)) = found else {
        return Ok(None);
    };
    let available = AvailableUpdate {
        version: update.version.clone(),
        release_url: format!("{releases}/tag/{tag}"),
        installable: installable(),
    };
    *lock(&pending.update) = Some(update);
    Ok(Some(available))
}

/// The update of the newest of the `candidates` that has one for this
/// platform, as `fetch` reads it from the release's `latest.json`, with that
/// release's version. Tries [`CANDIDATES`] releases at most, and fails when
/// none had an update but one was tried.
async fn first_update<T, Fut>(
    candidates: &[Version],
    version_of: impl Fn(&T) -> &str,
    mut fetch: impl FnMut(Version) -> Fut,
) -> Result<Option<(Version, T)>, CommandError>
where
    Fut: Future<Output = Option<T>>,
{
    let mut failed = false;
    for tag in candidates.iter().take(CANDIDATES) {
        match fetch(tag.clone()).await {
            Some(update) if is_release(version_of(&update), tag) => {
                return Ok(Some((tag.clone(), update)))
            }
            _ => failed = true,
        }
    }
    if failed {
        return Err(check_failed());
    }
    Ok(None)
}

/// The update `latest.json` of the release `version` describes.
async fn fetch_update<R: Runtime>(
    app: &AppHandle<R>,
    releases: &str,
    version: &Version,
) -> tauri_plugin_updater::Result<Option<Update>> {
    let manifest = Url::parse(&format!("{releases}/download/{version}/latest.json"))
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

/// Whether a manifest's `version` is that of the release `tag` it came with.
/// The channel is picked by tag, so a manifest naming another version, such
/// as an alpha in a stable release, could leave the channel. The update's
/// signature in turn names the manifest's version (`requireSignedVersion`).
fn is_release(version: &str, tag: &Version) -> bool {
    Version::parse(version).is_ok_and(|version| version == *tag)
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
    let reports = Mutex::new(ProgressReports::default());
    let bytes = update
        .download(
            |chunk, total| {
                if let Some(report) = lock(&reports).chunk(chunk, total) {
                    let _ = progress.send(report);
                }
            },
            || {
                let _ = progress.send(lock(&reports).finished());
            },
        )
        .await
        .map_err(|_| update_failed().with_diagnostic("update_download_failed"))?;
    pending.steps.downloaded(bytes);
    Ok(())
}

/// Install the downloaded update. Refused while an installation runs, and no
/// installation starts until it's done. On Windows the installer takes over
/// and the app exits; elsewhere the update starts with
/// `restart_after_update`. Installing again does nothing.
#[tauri::command]
pub async fn install_update(pending: State<'_, PendingUpdate>) -> Result<(), CommandError> {
    let update = pending.update().ok_or_else(no_update)?;
    let operation = Operation::new("update_install");
    let result = pending
        .steps
        .install(move |bytes| update.install(bytes).is_ok())
        .await;
    operation.finish(result)
}

/// Start the installed update. Refused while an installation runs, and no
/// installation starts after it: nothing in the app calls off an exit, so
/// the restart goes ahead.
#[tauri::command]
pub fn restart_after_update<R: Runtime>(
    app: AppHandle<R>,
    pending: State<'_, PendingUpdate>,
) -> Result<(), CommandError> {
    pending.steps.restart(|| app.request_restart())
}

fn installation_running() -> CommandError {
    CommandError::new(
        "operation_in_progress",
        "Finish the installation before updating the installer.",
        true,
    )
}

fn no_update() -> CommandError {
    CommandError::new("update_failed", "There is no update to install.", false)
}

fn update_failed() -> CommandError {
    CommandError::new("update_failed", "The update could not be installed.", true)
}

fn install_failed() -> CommandError {
    update_failed().with_diagnostic("update_install_failed")
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

    #[test]
    fn takes_only_the_manifest_of_the_release_it_came_with() {
        let tag = Version::parse("2026.11.1").unwrap();
        assert!(is_release("2026.11.1", &tag));
        // A stable release's manifest can't hand out a newer alpha
        assert!(!is_release("2026.12.0-alpha.1", &tag));
        assert!(!is_release("2026.11.0", &tag));
        assert!(!is_release("not a version", &tag));
    }

    /// The releases `first_update` tried, and what it found.
    async fn first(
        candidates: &[&str],
        manifests: &[(&str, Option<&str>)],
    ) -> (Vec<String>, Result<Option<String>, CommandError>) {
        let candidates: Vec<_> = candidates
            .iter()
            .map(|tag| Version::parse(tag).unwrap())
            .collect();
        let mut tried = Vec::new();
        let found = first_update(
            &candidates,
            |version: &String| version,
            |tag| {
                tried.push(tag.to_string());
                // A release's manifest names this version, or there is none
                let version = manifests
                    .iter()
                    .find(|(release, _)| *release == tag.to_string())
                    .and_then(|(_, version)| version.map(str::to_owned));
                async move { version }
            },
        )
        .await
        .map(|found| found.map(|(tag, version)| format!("{tag} {version}")));
        (tried, found)
    }

    #[tokio::test]
    async fn takes_the_newest_release_with_an_update() {
        let (tried, found) = first(
            &["2026.12.0", "2026.11.1"],
            &[("2026.12.0", Some("2026.12.0"))],
        )
        .await;
        assert_eq!(tried, ["2026.12.0"]);
        assert_eq!(found.unwrap().as_deref(), Some("2026.12.0 2026.12.0"));
    }

    #[tokio::test]
    async fn falls_back_past_releases_without_an_update_of_their_own() {
        // No manifest for this platform, then one naming another version
        let (tried, found) = first(
            &["2026.12.1", "2026.12.0", "2026.11.1"],
            &[
                ("2026.12.0", Some("2026.13.0-alpha.1")),
                ("2026.11.1", Some("2026.11.1")),
            ],
        )
        .await;
        assert_eq!(tried, ["2026.12.1", "2026.12.0", "2026.11.1"]);
        assert_eq!(found.unwrap().as_deref(), Some("2026.11.1 2026.11.1"));
    }

    #[tokio::test]
    async fn tries_three_releases_at_most() {
        let (tried, found) = first(
            &["2026.12.3", "2026.12.2", "2026.12.1", "2026.12.0"],
            &[("2026.12.0", Some("2026.12.0"))],
        )
        .await;
        assert_eq!(tried, ["2026.12.3", "2026.12.2", "2026.12.1"]);
        let error = found.err().unwrap();
        assert_eq!(error.code, "network");
        assert_eq!(error.diagnostic, "update_check_failed");
    }

    #[tokio::test]
    async fn no_newer_release_is_no_update() {
        let (tried, found) = first(&[], &[]).await;
        assert!(tried.is_empty());
        assert_eq!(found.unwrap(), None);
    }

    #[test]
    fn reports_each_percent_of_a_download() {
        let mut reports = ProgressReports::default();
        let total = Some(1000);
        let progress = |downloaded| UpdateProgress { downloaded, total };
        assert_eq!(reports.chunk(5, total), Some(progress(5)));
        // Less than a percent more
        assert_eq!(reports.chunk(9, total), None);
        assert_eq!(reports.chunk(1, total), Some(progress(15)));
        assert_eq!(reports.chunk(10, total), Some(progress(25)));
        assert_eq!(reports.chunk(3, total), None);
        assert_eq!(
            reports.finished(),
            UpdateProgress {
                downloaded: 28,
                total: Some(28)
            }
        );
    }

    #[test]
    fn reports_each_mib_of_a_download_of_unknown_size() {
        let mut reports = ProgressReports::default();
        assert!(reports.chunk(10, None).is_some());
        assert_eq!(reports.chunk((1 << 20) - 1, None), None);
        assert!(reports.chunk(1, None).is_some());
    }

    /// Update steps with jobs of their own, and the update downloaded.
    fn downloaded(jobs: &'static JobCounter) -> UpdateSteps {
        let steps = UpdateSteps::new(jobs);
        steps.downloaded(b"update".to_vec());
        steps
    }

    #[tokio::test]
    async fn installing_waits_for_a_running_job_and_keeps_the_update() {
        static JOBS: JobCounter = JobCounter::new();
        let steps = downloaded(&JOBS);

        let job = JOBS.start().unwrap();
        let error = steps
            .install(|_| unreachable!("installed during a job"))
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "operation_in_progress");
        assert!(error.retryable);
        drop(job);

        steps.install(|bytes| bytes == b"update").await.unwrap();
    }

    #[tokio::test]
    async fn no_job_starts_while_the_update_installs() {
        static JOBS: JobCounter = JobCounter::new();
        let steps = downloaded(&JOBS);

        steps.install(|_| JOBS.start().is_err()).await.unwrap();
        // Until the restart, it may
        assert!(JOBS.start().is_ok());
    }

    #[tokio::test]
    async fn installing_needs_a_downloaded_update() {
        static JOBS: JobCounter = JobCounter::new();
        let steps = UpdateSteps::new(&JOBS);

        let error = steps
            .install(|_| unreachable!("nothing to install"))
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "update_failed");
        assert!(!error.retryable);
        assert!(JOBS.start().is_ok());
    }

    #[tokio::test]
    async fn a_failed_install_can_be_tried_again() {
        static JOBS: JobCounter = JobCounter::new();
        let steps = downloaded(&JOBS);

        let error = steps.install(|_| false).await.err().unwrap();
        assert_eq!(error.code, "update_failed");
        assert_eq!(error.diagnostic, "update_install_failed");
        assert!(error.retryable);
        assert!(JOBS.start().is_ok());

        steps.install(|bytes| bytes == b"update").await.unwrap();
    }

    #[tokio::test]
    async fn installing_again_does_nothing() {
        static JOBS: JobCounter = JobCounter::new();
        let steps = downloaded(&JOBS);

        steps.install(|_| true).await.unwrap();
        steps
            .install(|_| unreachable!("installed twice"))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_new_check_forgets_the_last_update() {
        static JOBS: JobCounter = JobCounter::new();
        let steps = downloaded(&JOBS);
        steps.install(|_| true).await.unwrap();

        steps.reset();
        assert_eq!(steps.restart(|| {}).err().unwrap().code, "update_failed");
        let error = steps
            .install(|_| unreachable!("nothing to install"))
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "update_failed");
    }

    #[tokio::test]
    async fn restarts_only_into_an_installed_update() {
        static JOBS: JobCounter = JobCounter::new();
        let steps = downloaded(&JOBS);

        let error = steps
            .restart(|| unreachable!("restarted before installing"))
            .err()
            .unwrap();
        assert_eq!(error.code, "update_failed");
        assert!(JOBS.start().is_ok());

        steps.install(|_| false).await.err().unwrap();
        steps
            .restart(|| unreachable!("restarted after a failed install"))
            .err()
            .unwrap();
    }

    #[tokio::test]
    async fn the_restart_waits_for_a_running_job_then_holds_jobs_back() {
        static JOBS: JobCounter = JobCounter::new();
        let steps = downloaded(&JOBS);
        steps.install(|_| true).await.unwrap();

        let job = JOBS.start().unwrap();
        let error = steps
            .restart(|| unreachable!("restarted during a job"))
            .err()
            .unwrap();
        assert_eq!(error.code, "operation_in_progress");
        drop(job);

        let mut restarts = 0;
        steps.restart(|| restarts += 1).unwrap();
        assert_eq!(JOBS.start().err().unwrap().code, "installer_updating");
        // Asked again, as the app was still there, it restarts again
        steps.restart(|| restarts += 1).unwrap();
        assert_eq!(restarts, 2);
        assert!(JOBS.start().is_err());
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

    /// A key pair for these tests only, without a password, and an update it
    /// signed: `npx tauri signer generate`, then `npx tauri signer sign`.
    const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEI1NjExMzg0NjRBNzMyMEUKUldRT01xZGtoQk5odGRRUFdFY0szVk5NRHdqbWV5OFpxU3d5S29ucVVxb2NJZWZldWxkcGk1Vk0K";
    const TEST_UPDATE: &[u8] = b"the update";
    const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRT01xZGtoQk5odGJkRzZ0MGlCbVcxc1hjbU11QkJycFl0NXJGbXF2K2hUQUxpTFN2QVZXa1NlSUhQeFlLTTl1dDZUcDJoMDQxSm04YU82ZTRIaCtYMWYvVnVuazJXWEFBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzODk3NDkwCWZpbGU6dXBkYXRlLmJpbgpiNnR3VjNaazJlVHcraVJKTDhzUEJZVHArOUpwZjMvaTBiVC9TSVhLbzF5azlkTWZxUkJsV1MwbVZEWUxPVEI4ZDFyc2JMTUNYT2wzMFNKMFRWWVhEUT09Cg==";

    /// An app at `version`, which looks for updates on `server`.
    fn app_at(version: &str, server: &str) -> tauri::App<tauri::test::MockRuntime> {
        use tauri::Manager;

        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({ "pubkey": TEST_PUBKEY }),
        );
        context.package_info_mut().version = Version::parse(version).unwrap();
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        app.manage(PendingUpdate {
            source: Source {
                tags_api: format!("{server}/tags/"),
                releases: format!("{server}/releases"),
            },
            ..PendingUpdate::default()
        });
        app
    }

    /// A release's `latest.json`, for every platform the tests run on.
    fn manifest(server: &str, version: &str) -> String {
        let update = serde_json::json!({
            "signature": TEST_SIGNATURE,
            "url": format!("{server}/update"),
        });
        let platforms: serde_json::Map<_, _> = [
            "linux-x86_64",
            "linux-aarch64",
            "darwin-x86_64",
            "darwin-aarch64",
            "windows-x86_64",
            "windows-aarch64",
        ]
        .into_iter()
        .map(|platform| (platform.to_owned(), update.clone()))
        .collect();
        serde_json::json!({ "version": version, "platforms": platforms }).to_string()
    }

    /// The progress `download_update` reports, as the frontend gets it.
    fn progress_channel() -> (
        Channel<UpdateProgress>,
        std::sync::Arc<Mutex<Vec<UpdateProgress>>>,
    ) {
        let reports = std::sync::Arc::new(Mutex::new(Vec::new()));
        let channel = Channel::new({
            let reports = std::sync::Arc::clone(&reports);
            move |body| {
                lock(&reports).push(body.deserialize::<UpdateProgress>().unwrap());
                Ok(())
            }
        });
        (channel, reports)
    }

    /// Serve the tags, and `latest.json` of the releases that have one.
    async fn serve_releases(server: &mut mockito::ServerGuard, tags: &[&str], manifests: &[&str]) {
        let refs: Vec<_> = tags
            .iter()
            .map(|tag| serde_json::json!({ "ref": format!("refs/tags/{tag}") }))
            .collect();
        server
            .mock("GET", "/tags/")
            .with_body(serde_json::Value::from(refs).to_string())
            .create_async()
            .await;
        let url = server.url();
        for version in manifests {
            server
                .mock(
                    "GET",
                    format!("/releases/download/{version}/latest.json").as_str(),
                )
                .with_body(manifest(&url, version))
                .create_async()
                .await;
        }
    }

    #[tokio::test]
    async fn finds_downloads_and_verifies_an_update() {
        use tauri::Manager;

        let mut server = mockito::Server::new_async().await;
        // The newest release has no latest.json, as if made by hand
        serve_releases(
            &mut server,
            &["2026.12.0", "2026.11.1", "2026.11.0"],
            &["2026.11.1"],
        )
        .await;
        server
            .mock("GET", "/update")
            .with_body(TEST_UPDATE)
            .create_async()
            .await;
        let app = app_at("2026.11.0", &server.url());

        let available = check_for_update(app.handle().clone(), app.state())
            .await
            .unwrap();
        assert_eq!(
            available,
            Some(AvailableUpdate {
                version: "2026.11.1".into(),
                release_url: format!("{}/releases/tag/2026.11.1", server.url()),
                installable: true,
            })
        );

        let (progress, reports) = progress_channel();
        download_update(app.state(), progress).await.unwrap();
        let length = TEST_UPDATE.len() as u64;
        assert_eq!(
            lock(&reports).last(),
            Some(&UpdateProgress {
                downloaded: length,
                total: Some(length)
            })
        );
        let pending = app.state::<PendingUpdate>();
        assert_eq!(lock(&pending.steps.bytes).as_deref(), Some(TEST_UPDATE));
    }

    #[tokio::test]
    async fn refuses_an_update_its_signature_doesnt_match() {
        use tauri::Manager;

        let mut server = mockito::Server::new_async().await;
        serve_releases(&mut server, &["2026.11.1"], &["2026.11.1"]).await;
        server
            .mock("GET", "/update")
            .with_body("another update")
            .create_async()
            .await;
        let app = app_at("2026.11.0", &server.url());
        check_for_update(app.handle().clone(), app.state())
            .await
            .unwrap()
            .unwrap();

        let (progress, _) = progress_channel();
        let error = download_update(app.state(), progress).await.err().unwrap();
        assert_eq!(error.code, "update_failed");
        assert_eq!(error.diagnostic, "update_download_failed");
        assert!(error.retryable);
        assert!(lock(&app.state::<PendingUpdate>().steps.bytes).is_none());
    }

    #[tokio::test]
    async fn a_release_without_any_update_fails_the_check() {
        let mut server = mockito::Server::new_async().await;
        serve_releases(&mut server, &["2026.11.1"], &[]).await;
        let app = app_at("2026.11.0", &server.url());

        let error = check_for_update(app.handle().clone(), tauri::Manager::state(&app))
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "network");
        assert_eq!(error.diagnostic, "update_check_failed");
    }

    #[tokio::test]
    async fn a_build_that_isnt_a_release_never_checks() {
        let mut server = mockito::Server::new_async().await;
        let tags = server.mock("GET", "/tags/").expect(0).create_async().await;
        let app = app_at("0.0.0", &server.url());

        let available = check_for_update(app.handle().clone(), tauri::Manager::state(&app))
            .await
            .unwrap();
        assert_eq!(available, None);
        tags.assert_async().await;
    }

    #[tokio::test]
    async fn without_a_found_update_nothing_downloads_installs_or_restarts() {
        use tauri::Manager;

        let app = app_at("2026.11.0", "http://127.0.0.1:9");
        let (progress, _) = progress_channel();
        let error = download_update(app.state(), progress).await.err().unwrap();
        assert_eq!(error.code, "update_failed");
        let error = install_update(app.state()).await.err().unwrap();
        assert_eq!(error.code, "update_failed");
        let error = restart_after_update(app.handle().clone(), app.state())
            .err()
            .unwrap();
        assert_eq!(error.code, "update_failed");
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
