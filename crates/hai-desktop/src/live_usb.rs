//! Live USB commands: build a bootable stick or ISO for a mini PC with `hai_core::live_usb`.
//!
//! With the `mock` feature these commands only report fake progress: building the media
//! needs the real Alpine and HAOS downloads, and a mock build must never write a drive.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use hai_core::{
    BlockDevice, DeviceBackend, ExpectedDevice, FlashProgress, FlashStage, ProgressCallback,
};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::backend::Backend;
use crate::close_guard::running_job;
use crate::command_error::CommandError;
use crate::commands::{check_cancelled, keep_awake, TauriProgressCallback};
use crate::flash_state::FlashState;

/// Lets testers point the app at a `hai-live` build kept anywhere, such as Downloads.
const HAI_LIVE_ENV: &str = "HAI_LIVE_PATH";
const HAI_LIVE_NAME: &str = "hai-live";

/// What the live USB flow needs before it can start.
#[derive(Debug, Serialize, PartialEq)]
pub struct LiveUsbStatus {
    /// The `hai-live` program for the stick was found.
    pub hai_live_found: bool,
    /// Writing a stick needs the app restarted as administrator (Windows only).
    pub needs_admin: bool,
}

/// Checks for `hai-live` and, on Windows, administrator rights.
#[tauri::command]
pub async fn live_usb_status() -> LiveUsbStatus {
    LiveUsbStatus {
        hai_live_found: cfg!(feature = "mock") || find_hai_live().is_some(),
        needs_admin: matches!(
            Backend.check_write_privileges(),
            Err(hai_core::Error::PermissionDenied(_))
        ),
    }
}

/// Downloads Alpine and HAOS (or reuses the cache), builds the stick image and writes it to
/// the removable drive `device_id` with read-back verification. `cancel_flash(attempt)`
/// stops it.
#[tauri::command]
pub async fn create_live_usb(
    device_id: String,
    expected_device: ExpectedDevice,
    attempt: String,
    progress_channel: Channel<FlashProgress>,
    state: tauri::State<'_, FlashState>,
) -> Result<(), CommandError> {
    state
        .run(attempt, |cancelled| async move {
            let _running = running_job();
            let _awake = keep_awake("Creating a Home Assistant USB stick").await;
            let callback =
                TauriProgressCallback::new(&progress_channel, "live_usb").cancellable(cancelled);
            let result = run_create_live_usb(&device_id, &expected_device, &callback).await;
            callback.operation.finish(result)
        })
        .await
}

/// Builds the ISO and saves it as `folder/file_name`, replacing an existing file only
/// with `overwrite`. Returns the saved path. `cancel_flash(attempt)` stops it.
#[tauri::command]
pub async fn save_live_iso(
    folder: String,
    file_name: String,
    overwrite: bool,
    attempt: String,
    progress_channel: Channel<FlashProgress>,
    state: tauri::State<'_, FlashState>,
) -> Result<String, CommandError> {
    state
        .run(attempt, |cancelled| async move {
            let _running = running_job();
            let _awake = keep_awake("Creating a Home Assistant ISO file").await;
            let callback =
                TauriProgressCallback::new(&progress_channel, "live_iso").cancellable(cancelled);
            let result =
                run_save_live_iso(Path::new(&folder), &file_name, overwrite, &callback).await;
            callback
                .operation
                .finish(result)
                .map(|path| path.to_string_lossy().into_owned())
        })
        .await
}

/// Result of checking a save location before anything is downloaded.
#[derive(Debug, Serialize, PartialEq)]
pub struct IsoLocation {
    /// A file with this name is already there; saving replaces it.
    pub exists: bool,
}

/// Checks the name, that the folder exists and can be written, and whether the file exists.
/// Off the main thread: the folder can be a slow network share or a sleeping disk.
#[tauri::command(async)]
pub fn check_iso_location(folder: String, file_name: String) -> Result<IsoLocation, CommandError> {
    let folder = Path::new(&folder);
    let target = iso_target(folder, &file_name, true)?;
    if !cfg!(feature = "mock") {
        // Removed again at once; it only proves the folder can be written.
        if target.exists() {
            tempfile::Builder::new()
                .prefix(".hai-live-")
                .tempdir_in(folder)?;
        } else {
            // The exact name, so names the file system refuses fail now, not after the build.
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)?;
            std::fs::remove_file(&target)?;
        }
    }
    Ok(IsoLocation {
        exists: target.exists(),
    })
}

/// Opens the file manager with `path` selected.
#[tauri::command]
pub fn reveal_in_folder(app: tauri::AppHandle, path: String) -> Result<(), CommandError> {
    if cfg!(feature = "mock") {
        return Ok(());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|_| CommandError::new("io", "Could not open the folder.", false))
}

/// Restarts the app as administrator. The flow starts again in the new window.
#[tauri::command]
pub fn relaunch_as_admin(app: tauri::AppHandle) -> Result<(), CommandError> {
    crate::elevation::relaunch_as_admin()?;
    app.exit(0);
    Ok(())
}

#[cfg(not(feature = "mock"))]
async fn run_create_live_usb<P: ProgressCallback>(
    device_id: &str,
    expected: &ExpectedDevice,
    callback: &P,
) -> Result<(), CommandError> {
    // Same order as the regular flash: no download when the write can't happen anyway.
    Backend
        .check_write_privileges()
        .map_err(CommandError::from)?;
    let hai_live = find_hai_live().ok_or_else(hai_live_missing)?;
    let contents = hai_core::live_usb::prepare(&Backend, &hai_live, callback).await?;
    check_cancelled(callback)?;

    report(
        callback,
        FlashStage::Extracting,
        "Preparing the USB stick...",
    );
    let temp = tempfile::Builder::new()
        .prefix("usb-image-")
        .tempdir_in(hai_core::live_usb::cache_dir(&Backend)?)?;
    let out_dir = temp.path().to_path_buf();
    let image = build_until_stopped(callback, move |stop| {
        hai_core::live_usb::write_image(&contents, &out_dir, stop)
    })
    .await?;

    // Last point where the stick is still untouched
    check_cancelled(callback)?;
    write_to_usb(&image, device_id, expected, callback).await?;
    drop(temp);
    remove_downloads();
    report(callback, FlashStage::Complete, "USB stick ready");
    Ok(())
}

/// Made, so the downloads are no longer needed. Failing to remove them only costs
/// disk space until the next start, which tries again.
#[cfg(not(feature = "mock"))]
fn remove_downloads() {
    let removed = hai_core::ReleaseSource::cache_dir(&Backend)
        .and_then(|cache| hai_core::live_usb::remove_cache(&cache));
    if removed.is_err() {
        crate::diagnostics::warning("live_usb_cache_cleanup_failed");
    }
}

/// Writes `image` to the stick `device_id` with read-back verification.
#[cfg(not(feature = "mock"))]
async fn write_to_usb<P: ProgressCallback>(
    image: &Path,
    device_id: &str,
    expected: &ExpectedDevice,
    progress: &P,
) -> Result<(), CommandError> {
    Backend.check_write_privileges()?;
    let image_size = std::fs::metadata(image)?.len();
    let devices = Backend.list_devices().await?;
    find_live_usb_target(&devices, device_id, expected, image_size)?;
    Backend
        .write_image(
            &hai_core::disk::Image::new(image),
            device_id,
            expected,
            true,
            progress,
        )
        .await?;
    Ok(())
}

/// Find the stick among the currently attached devices.
///
/// The safety gate before writing, like `find_flash_target` for the regular flash: the
/// device must be removable, still the drive the user selected, and big enough for `image_size`.
#[cfg_attr(feature = "mock", allow(dead_code))]
fn find_live_usb_target<'a>(
    devices: &'a [BlockDevice],
    device_id: &str,
    expected: &ExpectedDevice,
    image_size: u64,
) -> Result<&'a BlockDevice, CommandError> {
    let device = devices
        .iter()
        .find(|d| d.id == device_id)
        .ok_or_else(|| hai_core::Error::DeviceNotFound(device_id.into()))?;
    if !device.removable {
        return Err(CommandError::new(
            "invalid_config",
            "The selected drive is not removable, so it won't be written.",
            false,
        ));
    }
    if !expected.matches(device) {
        return Err(CommandError::new(
            "device_not_found",
            "The USB stick is no longer the one you selected. Select it again.",
            false,
        ));
    }
    hai_core::disk::ensure_image_fits(image_size, device.size)?;
    Ok(device)
}

#[cfg(feature = "mock")]
async fn run_create_live_usb<P: ProgressCallback>(
    _device_id: &str,
    _expected: &ExpectedDevice,
    callback: &P,
) -> Result<(), CommandError> {
    for stage in [
        FlashStage::Downloading,
        FlashStage::Extracting,
        FlashStage::Writing,
        FlashStage::Verifying,
    ] {
        mock::simulate(callback, stage).await?;
    }
    report(callback, FlashStage::Complete, "USB stick ready (mock)");
    Ok(())
}

async fn run_save_live_iso<P: ProgressCallback>(
    folder: &Path,
    file_name: &str,
    overwrite: bool,
    callback: &P,
) -> Result<PathBuf, CommandError> {
    let target = iso_target(folder, file_name, overwrite)?;
    #[cfg(feature = "mock")]
    {
        for stage in [FlashStage::Downloading, FlashStage::Extracting] {
            mock::simulate(callback, stage).await?;
        }
        report(callback, FlashStage::Complete, "ISO saved (mock)");
        Ok(target)
    }
    #[cfg(not(feature = "mock"))]
    {
        let hai_live = find_hai_live().ok_or_else(hai_live_missing)?;
        // Created first, so an unwritable folder fails before anything is downloaded.
        let temp = tempfile::Builder::new()
            .prefix(".hai-live-")
            .tempdir_in(folder)?;
        let contents = hai_core::live_usb::prepare(&Backend, &hai_live, callback).await?;
        check_cancelled(callback)?;

        report(callback, FlashStage::Extracting, "Building the ISO...");
        let out_dir = temp.path().to_path_buf();
        let built = build_until_stopped(callback, move |stop| {
            hai_core::live_usb::write_iso(&contents, &out_dir, stop)
        })
        .await?;
        // hai-core picks its own name; building in a temporary folder means an existing
        // file with that name next to the target is never overwritten.
        iso_target(folder, file_name, overwrite)?;
        publish_iso(&built, &target, overwrite)?;
        drop(temp);
        remove_downloads();
        report(callback, FlashStage::Complete, "ISO saved");
        Ok(target)
    }
}

/// Moves the finished ISO to `target`. Without `overwrite` the name is claimed first, so a
/// file that appeared there during the build is never replaced.
#[cfg_attr(feature = "mock", allow(dead_code))]
fn publish_iso(built: &Path, target: &Path, overwrite: bool) -> Result<(), CommandError> {
    if !overwrite {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::AlreadyExists => file_exists(),
                _ => error.into(),
            })?;
    }
    // Replaces in one step on every platform, so a failure keeps the old file.
    std::fs::rename(built, target).map_err(|error| {
        if !overwrite {
            let _ = std::fs::remove_file(target);
        }
        CommandError::from(error)
    })
}

fn file_exists() -> CommandError {
    CommandError::new(
        "file_exists",
        "A file with this name already exists. Choose another name or folder.",
        false,
    )
}

/// Where the ISO goes, refusing names that point elsewhere, and replacing an existing
/// file only with `overwrite`.
fn iso_target(folder: &Path, file_name: &str, overwrite: bool) -> Result<PathBuf, CommandError> {
    let name = file_name.trim();
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(CommandError::new(
            "invalid_file_name",
            "Enter a file name without folder separators.",
            false,
        ));
    }
    if !is_portable_file_name(name) {
        return Err(CommandError::new(
            "file_name_not_portable",
            "This file name can't be used. Leave out < > : \" | ? * and don't use names like CON or NUL.",
            false,
        ));
    }
    if !folder.is_dir() {
        return Err(CommandError::new(
            "folder_not_found",
            "The folder doesn't exist. Choose another folder.",
            false,
        ));
    }
    // The installer clears its own downloads there, and the system may empty its
    // cache folder at any time: no place for a file to keep
    let in_cache =
        hai_core::ReleaseSource::cache_dir(&Backend).is_ok_and(|cache| is_inside(folder, &cache));
    if in_cache {
        return Err(CommandError::new(
            "folder_in_cache",
            "This is the installer's own cache folder, which gets cleared. Choose another folder, such as Downloads.",
            false,
        ));
    }
    let target = folder.join(name);
    if target.is_dir() {
        return Err(CommandError::new(
            "folder_name_taken",
            "A folder with this name is already there. Choose another file name.",
            false,
        ));
    }
    if target.exists() && !overwrite {
        return Err(file_exists());
    }
    Ok(target)
}

/// Whether `folder` is `cache` or inside it, also when a symlink leads there.
fn is_inside(folder: &Path, cache: &Path) -> bool {
    match (folder.canonicalize(), cache.canonicalize()) {
        (Ok(folder), Ok(cache)) => folder.starts_with(cache),
        // A cache folder that can't be resolved doesn't exist, so nothing is in it
        _ => false,
    }
}

/// Whether Windows accepts `name` (checked everywhere, since the ISO may be copied there):
/// no reserved characters, no trailing dot, and not a device name such as `CON.iso`.
fn is_portable_file_name(name: &str) -> bool {
    if name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"|?*".contains(c))
    {
        return false;
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    let stem = stem.to_ascii_uppercase();
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix)
            .is_some_and(|n| n.len() == 1 && n.as_bytes()[0].is_ascii_digit())
    };
    !(matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered("COM") || numbered("LPT"))
}

/// The first place `hai-live` is found: the environment variable alone if it is set,
/// otherwise the app's bundled resources, next to the app, then (developer builds) the
/// repo's musl build folder. A file that isn't the Linux build is only used if no
/// other place has one, so the error can say so.
fn find_hai_live() -> Option<PathBuf> {
    locate_hai_live(
        std::env::var_os(HAI_LIVE_ENV),
        RESOURCE_DIR.get().map(PathBuf::as_path),
        hai_core::live_usb::is_usable_hai_live,
    )
}

fn locate_hai_live(
    env: Option<OsString>,
    resource_dir: Option<&Path>,
    is_usable: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if let Some(path) = env {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }
    let bundled = resource_dir.map(|dir| dir.join(HAI_LIVE_NAME));
    let next_to_app = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(HAI_LIVE_NAME)));
    let repo_build = cfg!(debug_assertions).then(|| {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/x86_64-unknown-linux-musl/release")
            .join(HAI_LIVE_NAME)
    });
    pick_hai_live(
        [bundled, next_to_app, repo_build].into_iter().flatten(),
        is_usable,
    )
}

/// The first usable file among `candidates`, else the first one that exists.
fn pick_hai_live(
    candidates: impl IntoIterator<Item = PathBuf>,
    is_usable: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let found: Vec<PathBuf> = candidates
        .into_iter()
        .filter(|path| path.is_file())
        .collect();
    // On macOS and Linux, target/debug also holds a host build of hai-live
    found
        .iter()
        .find(|path| is_usable(path))
        .or(found.first())
        .cloned()
}

/// Where Tauri put the files bundled with the app (release builds include `hai-live`).
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Called once at startup.
pub(crate) fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

#[cfg_attr(feature = "mock", allow(dead_code))]
fn hai_live_missing() -> CommandError {
    CommandError::new(
        "hai_live_missing",
        "The program for the USB stick (hai-live) wasn't found. Build it with \
         `cargo build --release -p hai-live --target x86_64-unknown-linux-musl`, \
         or set HAI_LIVE_PATH to its location, then restart the installer.",
        false,
    )
}

/// Run a blocking build of the stick or ISO, stopping it as soon as the user stops. Building
/// takes minutes and only notices `stop` at its next write. Even then it's awaited, so the
/// half-built file is no longer being written once its folder is removed.
#[cfg(not(feature = "mock"))]
async fn build_until_stopped<P, T>(
    callback: &P,
    build: impl FnOnce(&std::sync::atomic::AtomicBool) -> hai_core::Result<T> + Send + 'static,
) -> Result<T, CommandError>
where
    P: ProgressCallback,
    T: Send + 'static,
{
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut task = tokio::task::spawn_blocking({
        let stop = stop.clone();
        move || build(&stop)
    });
    let mut check = tokio::time::interval(std::time::Duration::from_millis(100));
    loop {
        tokio::select! {
            built = &mut task => {
                let built = built.map_err(|_| stopped())?;
                check_cancelled(callback)?;
                return Ok(built?);
            }
            _ = check.tick() => {
                if callback.is_cancelled() {
                    stop.store(true, Ordering::Release);
                }
            }
        }
    }
}

#[cfg(not(feature = "mock"))]
fn stopped() -> CommandError {
    CommandError::new(
        "internal",
        "Building the bootable media stopped unexpectedly.",
        false,
    )
}

fn report<P: ProgressCallback>(callback: &P, stage: FlashStage, message: &str) {
    let progress = if stage == FlashStage::Complete {
        100
    } else {
        0
    };
    callback.on_progress(FlashProgress {
        stage,
        progress,
        bytes_processed: 0,
        total_bytes: 0,
        message: message.to_string(),
    });
}

#[cfg(feature = "mock")]
mod mock {
    use super::*;

    const MOCK_BYTES: u64 = 500_000_000;

    /// A few seconds of progress for one stage, so the screens can be tried out.
    pub(super) async fn simulate<P: ProgressCallback>(
        callback: &P,
        stage: FlashStage,
    ) -> Result<(), CommandError> {
        let measured = stage != FlashStage::Extracting;
        for percent in (0..=100).step_by(10) {
            check_cancelled(callback)?;
            let bytes = MOCK_BYTES * percent / 100;
            callback.on_progress(FlashProgress {
                stage: stage.clone(),
                progress: percent as u8,
                bytes_processed: if measured { bytes } else { 0 },
                total_bytes: if measured { MOCK_BYTES } else { 0 },
                message: "mock".to_string(),
            });
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_inside_the_cache_is_recognized_also_through_a_symlink() {
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("cache");
        let live_usb = cache.join("live-usb").join("haos");
        std::fs::create_dir_all(&live_usb).unwrap();
        let elsewhere = root.path().join("Downloads");
        std::fs::create_dir_all(&elsewhere).unwrap();

        assert!(is_inside(&cache, &cache));
        assert!(is_inside(&live_usb, &cache));
        assert!(!is_inside(&elsewhere, &cache));
        // A sibling whose name starts the same is not inside
        let sibling = root.path().join("cache-copy");
        std::fs::create_dir_all(&sibling).unwrap();
        assert!(!is_inside(&sibling, &cache));
        // Nothing is inside a cache folder that isn't there
        assert!(!is_inside(&elsewhere, &root.path().join("missing")));

        #[cfg(unix)]
        {
            let link = root.path().join("shortcut");
            std::os::unix::fs::symlink(&live_usb, &link).unwrap();
            assert!(is_inside(&link, &cache));
        }
    }

    #[test]
    fn iso_target_refuses_the_installers_own_cache_folder() {
        let cache = hai_core::ReleaseSource::cache_dir(&Backend).unwrap();
        let error = iso_target(&cache, "stick.iso", false).unwrap_err();
        assert_eq!(error.code, "folder_in_cache");
    }

    #[test]
    fn iso_target_refuses_bad_names_and_replaces_files_only_when_asked() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            iso_target(dir.path(), " stick.iso ", false).unwrap(),
            dir.path().join("stick.iso")
        );
        for name in ["", "  ", "..", "sub/stick.iso", "sub\\stick.iso"] {
            assert_eq!(
                iso_target(dir.path(), name, true).unwrap_err().code,
                "invalid_file_name",
                "{name:?}"
            );
        }
        for name in [
            "CON.iso",
            "nul",
            "com1.iso",
            "Lpt9",
            "a:b.iso",
            "what?.iso",
            "stick.iso.",
        ] {
            assert_eq!(
                iso_target(dir.path(), name, true).unwrap_err().code,
                "file_name_not_portable",
                "{name:?}"
            );
        }
        for name in ["console.iso", "COM10.iso", "my stick (1).iso"] {
            assert!(iso_target(dir.path(), name, false).is_ok(), "{name:?}");
        }
        assert_eq!(
            iso_target(&dir.path().join("missing"), "stick.iso", true)
                .unwrap_err()
                .code,
            "folder_not_found"
        );
        std::fs::write(dir.path().join("stick.iso"), b"old").unwrap();
        assert_eq!(
            iso_target(dir.path(), "stick.iso", false).unwrap_err().code,
            "file_exists"
        );
        assert!(iso_target(dir.path(), "stick.iso", true).is_ok());
        std::fs::create_dir(dir.path().join("taken.iso")).unwrap();
        assert_eq!(
            iso_target(dir.path(), "taken.iso", true).unwrap_err().code,
            "folder_name_taken"
        );
    }

    #[test]
    fn publishing_never_replaces_a_file_that_appeared_during_the_build() {
        let dir = tempfile::tempdir().unwrap();
        let built = dir.path().join("built.iso");
        let target = dir.path().join("stick.iso");
        std::fs::write(&built, b"ours").unwrap();
        std::fs::write(&target, b"theirs").unwrap();

        let error = publish_iso(&built, &target, false).unwrap_err();
        assert_eq!(error.code, "file_exists");
        assert_eq!(std::fs::read(&target).unwrap(), b"theirs");
        assert!(built.exists());
    }

    #[test]
    fn publishing_saves_a_new_file_and_replaces_only_when_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let built = dir.path().join("built.iso");
        let target = dir.path().join("stick.iso");
        std::fs::write(&built, b"first").unwrap();
        publish_iso(&built, &target, false).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"first");
        assert!(!built.exists());

        std::fs::write(&built, b"second").unwrap();
        publish_iso(&built, &target, true).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"second");
    }

    #[test]
    fn checking_a_location_reports_an_existing_file_and_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().into_owned();
        assert_eq!(
            check_iso_location(folder.clone(), "stick.iso".into()).unwrap(),
            IsoLocation { exists: false }
        );
        std::fs::write(dir.path().join("stick.iso"), b"old").unwrap();
        assert_eq!(
            check_iso_location(folder, "stick.iso".into()).unwrap(),
            IsoLocation { exists: true }
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn live_usb_target_accepts_the_same_removable_drive_with_room() {
        let devices = [drive("usb", 2_000_000_000, true)];
        let found =
            find_live_usb_target(&devices, "usb", &expected(&devices[0]), 1_000_000_000).unwrap();
        assert_eq!(found.id, "usb");
    }

    #[test]
    fn live_usb_target_refuses_unsafe_targets_without_naming_devices() {
        let fixed = drive("/dev/sdq", 500_000_000_000, false);
        let stick = drive(r"\\.\PhysicalDrive7", 2_000_000_000, true);
        let devices = [fixed.clone(), stick.clone()];
        let refused = |id: &str, expected: &ExpectedDevice, image_size: u64| {
            let error = find_live_usb_target(&devices, id, expected, image_size).unwrap_err();
            assert!(!error.message.contains("sdq"), "{error}");
            assert!(!error.message.contains("PhysicalDrive7"), "{error}");
            error.code
        };

        assert_eq!(refused(&fixed.id, &expected(&fixed), 1), "invalid_config");

        let mut swapped = expected(&stick);
        swapped.size = Some(4_000_000_000);
        assert_eq!(refused(&stick.id, &swapped, 1), "device_not_found");

        let mut same_model_other_stick = expected(&stick);
        same_model_other_stick.serial = Some("SN-2".into());
        assert_eq!(
            refused(&stick.id, &same_model_other_stick, 1),
            "device_not_found"
        );

        assert_eq!(
            refused(&stick.id, &expected(&stick), 3_000_000_000),
            "image_too_large"
        );
        assert_eq!(refused("gone", &expected(&stick), 1), "device_not_found");
    }

    fn drive(id: &str, size: u64, removable: bool) -> BlockDevice {
        BlockDevice {
            id: id.into(),
            name: id.into(),
            size,
            device_type: hai_core::DeviceType::UsbDrive,
            removable,
            model: Some("Stick".into()),
            vendor: Some("Acme".into()),
            serial: Some("SN-1".into()),
        }
    }

    fn expected(device: &BlockDevice) -> ExpectedDevice {
        ExpectedDevice {
            size: Some(device.size),
            model: device.model.clone(),
            vendor: device.vendor.clone(),
            serial: device.serial.clone(),
        }
    }

    #[test]
    #[serial_test::serial]
    fn hai_live_env_var_is_used_alone_when_set() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hai-live");
        std::env::set_var(HAI_LIVE_ENV, &path);
        assert_eq!(find_hai_live(), None);
        std::fs::write(&path, b"\x7fELF").unwrap();
        assert_eq!(find_hai_live(), Some(path));
        std::env::remove_var(HAI_LIVE_ENV);
    }

    #[test]
    fn bundled_hai_live_is_found_unless_the_env_var_points_elsewhere() {
        let resources = tempfile::tempdir().unwrap();
        let bundled = resources.path().join(HAI_LIVE_NAME);
        std::fs::write(&bundled, b"\x7fELF").unwrap();
        assert_eq!(
            locate_hai_live(None, Some(resources.path()), |_| true),
            Some(bundled)
        );
        assert_eq!(
            locate_hai_live(
                Some(resources.path().join("missing").into()),
                Some(resources.path()),
                |_| true
            ),
            None
        );
    }

    #[test]
    fn a_wrong_hai_live_build_does_not_hide_the_linux_one() {
        let dir = tempfile::tempdir().unwrap();
        let host = dir.path().join("host");
        let linux = dir.path().join("linux");
        let missing = dir.path().join("missing");
        std::fs::write(&host, b"host build").unwrap();
        std::fs::write(&linux, b"linux build").unwrap();
        let is_linux = |path: &Path| path.ends_with("linux");

        assert_eq!(
            pick_hai_live([missing.clone(), host.clone(), linux.clone()], is_linux),
            Some(linux)
        );
        // Nothing usable: the wrong one is still returned, so the error can say so
        assert_eq!(
            pick_hai_live([missing.clone(), host.clone()], is_linux),
            Some(host)
        );
        assert_eq!(pick_hai_live([missing], is_linux), None);
    }
}
