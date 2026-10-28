//! Tauri command wrappers for hai-core functionality
//!
//! This module provides Tauri IPC commands that wrap the hai-core library.
//! It handles the bridge between Tauri's Channel<T> and hai-core's ProgressCallback trait.

use crate::backend::Backend;
use crate::close_guard::running_job;
use crate::command_error::CommandError;
use crate::diagnostics::Operation;
use crate::flash_state::FlashState;
use crate::install_jobs::InstallJobs;
use hai_core::disk::Image;
use hai_core::keep_awake::KeepAwake;
use hai_core::{
    BlockDevice, DeviceBackend, DeviceManifest, ExpectedDevice, FlashProgress, FlashRequest,
    FlashResult, FlashStage, HaAnnouncement, HaSetupStatus, HaosRelease, HostBackend, ImageFormat,
    ProgressCallback, ProxmoxBackend, ProxmoxBridge, ProxmoxCredentials, ProxmoxNode,
    ProxmoxSession, ProxmoxStorage, ProxmoxVmConfig, ProxmoxVmResult, ReleaseSource, SystemInfo,
    UtmBackend, VmStatusInfo,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;

/// The images `download_utm_image` handed out, so a VM is only ever created
/// from one of them, never from a path the frontend passes in.
#[derive(Default)]
pub struct PendingUtmImages(std::sync::Mutex<std::collections::HashSet<String>>);

impl PendingUtmImages {
    fn insert(&self, image_path: String) {
        self.lock().insert(image_path);
    }

    fn take(&self, image_path: &str) -> bool {
        self.lock().remove(image_path)
    }

    /// A single insert or remove can't leave the set half-changed after a panic.
    fn lock(&self) -> std::sync::MutexGuard<'_, std::collections::HashSet<String>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// =============================================================================
// Tauri Progress Callback Adapter
// =============================================================================

/// Adapter that bridges Tauri's Channel with hai-core's ProgressCallback trait
pub(crate) struct TauriProgressCallback<'a> {
    channel: &'a Channel<FlashProgress>,
    pub(crate) operation: Operation,
    cancelled: Option<Arc<AtomicBool>>,
}

impl<'a> TauriProgressCallback<'a> {
    pub(crate) fn new(channel: &'a Channel<FlashProgress>, name: &'static str) -> Self {
        Self {
            channel,
            operation: Operation::new(name),
            cancelled: None,
        }
    }

    /// Let the operation stop once `cancelled` is set.
    pub(crate) fn cancellable(mut self, cancelled: Arc<AtomicBool>) -> Self {
        self.cancelled = Some(cancelled);
        self
    }
}

impl<'a> ProgressCallback for TauriProgressCallback<'a> {
    fn on_progress(&self, progress: FlashProgress) {
        let stage = match progress.stage {
            FlashStage::Downloading => "downloading",
            FlashStage::Extracting => "extracting",
            FlashStage::Writing => "writing",
            FlashStage::Verifying => "verifying",
            FlashStage::Finalizing => "finalizing",
            FlashStage::Uploading => "uploading",
            FlashStage::CreatingVm => "creating_vm",
            FlashStage::StartingVm => "starting_vm",
            FlashStage::Complete => "complete",
            // Keep the failing stage, never the backend's free-form message.
            FlashStage::Error => {
                let _ = self.channel.send(progress);
                return;
            }
        };
        self.operation.stage(stage);
        let _ = self.channel.send(progress);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled
            .as_ref()
            .is_some_and(|cancelled| cancelled.load(Ordering::Acquire))
    }
}

/// Keep the computer awake while a long job runs. Not getting that is only
/// logged: the job itself works fine as long as the computer stays awake.
pub(crate) async fn keep_awake(reason: &str) -> Option<KeepAwake> {
    KeepAwake::acquire(reason)
        .await
        .inspect_err(|_| crate::diagnostics::warning("keep_awake_unavailable"))
        .ok()
}

// =============================================================================
// Device Commands
// =============================================================================

/// Check internet access before starting an installation flow.
#[tauri::command]
pub async fn check_connection() -> Result<(), CommandError> {
    Backend
        .check_connection()
        .await
        .map_err(CommandError::from_query)
}

/// List all block devices
#[tauri::command]
pub async fn list_block_devices() -> Result<Vec<BlockDevice>, CommandError> {
    list_drives(&Backend).await
}

/// Refuses without write privileges, so the drive step says how to get them
/// before anyone picks a drive. Not retryable: they last until a restart.
async fn list_drives(backend: &impl DeviceBackend) -> Result<Vec<BlockDevice>, CommandError> {
    backend.check_write_privileges()?;
    backend
        .list_devices()
        .await
        .map_err(CommandError::from_query)
}

/// Restarts the app as administrator, which the drive step offers when
/// listing refused. The flow starts again in the new window.
#[tauri::command]
pub fn relaunch_as_admin(app: tauri::AppHandle) -> Result<(), CommandError> {
    crate::elevation::relaunch_as_admin()?;
    app.exit(0);
    Ok(())
}

// =============================================================================
// Flash Commands
// =============================================================================

/// Find the flash target among the currently attached devices.
///
/// `write_image` writes to whatever target it is given, so this lookup is the
/// safety gate: the device must be one that enumeration reported, and it must
/// be removable, and it must still match the drive the user selected, since
/// the path can be reassigned while the image downloads.
fn find_flash_target<'a>(
    devices: &'a [BlockDevice],
    device_id: &str,
    expected: &ExpectedDevice,
    board: &str,
) -> Result<&'a BlockDevice, CommandError> {
    let device = devices
        .iter()
        .find(|d| d.id == device_id)
        .ok_or_else(|| CommandError::from(hai_core::Error::DeviceNotFound(device_id.into())))?;

    if !expected.matches(device) {
        return Err(CommandError::new(
            "device_not_found",
            format!(
                "The drive at {} is no longer the one you selected. It may have been \
             swapped for another device; please select your drive again.",
                device_id
            ),
            false,
        ));
    }

    if !device.removable {
        return Err(CommandError::drive_in_system_use());
    }

    let config = hai_core::manifest::storage_requirements(board).ok_or_else(|| {
        CommandError::from(hai_core::Error::InvalidConfig(format!(
            "No storage requirements found for board: {}",
            board
        )))
    })?;
    if device.size < config.minimum_reported_storage_bytes() {
        // A board minimum, not the image size: a bigger drive is the only fix
        return Err(CommandError::with_message(
            "drive_too_small",
            &hai_core::message!(
                "backend.disk.drive_too_small",
                size = config.minimum_storage_bytes.div_ceil(1_000_000_000),
            ),
            false,
        ));
    }

    Ok(device)
}

/// Flash an image to a device
#[tauri::command]
pub async fn flash_image(
    request: FlashRequest,
    attempt: String,
    progress_channel: Channel<FlashProgress>,
    state: tauri::State<'_, FlashState>,
) -> Result<FlashResult, CommandError> {
    state
        .run(attempt, |cancelled| async move {
            let _running = running_job();
            let _awake = keep_awake("Writing Home Assistant to a drive").await;
            let callback =
                TauriProgressCallback::new(&progress_channel, "flash").cancellable(cancelled);
            callback
                .operation
                .finish(run_flash(&Backend, &request, &callback).await)
        })
        .await
}

/// Stop the flash started as `attempt`. `flash_image` then fails with
/// `cancelled` once nothing touches the drive anymore.
#[tauri::command]
pub fn cancel_flash(attempt: String, state: tauri::State<'_, FlashState>) {
    state.cancel(&attempt);
}

/// Stop between steps when the user cancelled.
pub(crate) fn check_cancelled<P: ProgressCallback>(callback: &P) -> Result<(), CommandError> {
    if callback.is_cancelled() {
        return Err(hai_core::Error::Cancelled.into());
    }
    Ok(())
}

/// Download, extract, and write the image for `request`.
///
/// Generic over the backend so the whole flow can be exercised against
/// `BackendMock`.
async fn run_flash<B, P>(
    backend: &B,
    request: &FlashRequest,
    callback: &P,
) -> Result<FlashResult, CommandError>
where
    B: ReleaseSource + DeviceBackend,
    P: ProgressCallback,
{
    let start_time = std::time::Instant::now();

    if let Some(wifi) = &request.wifi {
        // An installer would leave the network behind on the drive it runs from
        if hai_core::hardware_installer::find(&request.board).is_some() {
            return Err(hai_core::Error::InvalidConfig(
                "Wi-Fi can't be set up for this device.".into(),
            )
            .into());
        }
        hai_core::haos_config::validate(wifi)?;
    }

    // Send initial progress
    callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Fetching release info...".to_string(),
    });

    let image = match hai_core::hardware_installer::find(&request.board) {
        // Installer images are pinned, size and digest included, so there is
        // no release to look up. Everything below treats them like HAOS.
        Some(installer) => installer.image(),
        None => {
            // Fetch the release this board is on
            let release = backend
                .get_latest_haos_release_for_board(&request.board)
                .await
                .map_err(CommandError::from)?;

            // Find the raw disk image for the requested board. Some boards also
            // ship a qcow2 under the same board name, which must never be
            // written to a drive.
            release
                .image_for(&request.board, ImageFormat::Raw)
                .cloned()
                .ok_or_else(|| {
                    hai_core::Error::InvalidConfig(
                        "No compatible image was found for this device.".into(),
                    )
                })?
        }
    };

    callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 0,
        bytes_processed: 0,
        total_bytes: image.size,
        message: "Starting download...".to_string(),
    });

    let extracted_path = hai_core::download::fetch_image(backend, &image, callback)
        .await
        .map_err(CommandError::from)?;

    let mut image = Image::new(&extracted_path);
    if let Some(wifi) = request.wifi.clone() {
        image = tokio::task::spawn_blocking(move || hai_core::haos_config::with_wifi(image, &wifi))
            .await
            .map_err(|e| hai_core::Error::Io(std::io::Error::other(e)))??;
    }

    // Check image size vs device size
    let image_size = tokio::fs::metadata(&extracted_path)
        .await
        .map_err(CommandError::from)?
        .len();

    let device_list = backend.list_devices().await.map_err(CommandError::from)?;

    let device = find_flash_target(
        &device_list,
        &request.device_id,
        &request.expected_device,
        &request.board,
    )?;

    hai_core::disk::ensure_image_fits(image_size, device.size)?;

    // Last point where the drive is still untouched
    check_cancelled(callback)?;

    // Write to device
    backend
        .write_image(
            &image,
            &request.device_id,
            &request.expected_device,
            request.verify,
            callback,
        )
        .await
        .map_err(CommandError::from)?;

    let duration = start_time.elapsed();

    callback.on_progress(FlashProgress {
        stage: FlashStage::Complete,
        progress: 100,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Installation complete!".to_string(),
    });

    Ok(FlashResult {
        duration_secs: duration.as_secs(),
    })
}

// =============================================================================
// Release/Manifest Commands
// =============================================================================

/// Get the latest HAOS release information
#[tauri::command]
pub async fn get_haos_release(
    version: Option<String>,
    board: Option<String>,
) -> Result<HaosRelease, CommandError> {
    release_for_selection(&Backend, version.as_deref(), board.as_deref()).await
}

async fn release_for_selection<B: ReleaseSource>(
    backend: &B,
    version: Option<&str>,
    board: Option<&str>,
) -> Result<HaosRelease, CommandError> {
    let release = match (version, board) {
        (None | Some("latest"), Some(board)) => {
            backend.get_latest_haos_release_for_board(board).await
        }
        (version, _) => backend.get_haos_release(version.unwrap_or("latest")).await,
    };
    release.map_err(CommandError::from_query)
}

/// Get the device manifest
#[tauri::command]
pub async fn get_manifest() -> Result<DeviceManifest, CommandError> {
    Backend
        .get_device_manifest()
        .await
        .map_err(CommandError::from_query)
}

// =============================================================================
// System Info Commands
// =============================================================================

/// Get system information (CPU cores and memory) for VM configuration limits
#[tauri::command]
pub fn get_system_info() -> Result<SystemInfo, CommandError> {
    Backend.system_info().map_err(CommandError::from)
}

// =============================================================================
// UTM Commands (macOS only)
// =============================================================================

/// HAOS board for UTM, refused on an Intel Mac. The confirmation screen and
/// the download must agree on it.
fn utm_board() -> Result<&'static str, CommandError> {
    // The mock also runs off macOS, where there is no Mac to check
    #[cfg(any(not(feature = "mock"), target_os = "macos"))]
    hai_core::utm::ensure_apple_silicon().map_err(CommandError::from)?;

    Ok(hai_core::utm::HAOS_BOARD)
}

/// Whether this Mac can run a UTM install, so the path selection can say so
/// on an Intel Mac before anyone picks it.
#[tauri::command]
pub fn utm_supported() -> bool {
    supports_utm(hai_core::utm::ensure_apple_silicon())
}

/// Only an unsupported platform marks the option. Any other failure keeps it
/// open: the next screen reports it with its own message.
fn supports_utm(apple_silicon: hai_core::Result<()>) -> bool {
    !matches!(apple_silicon, Err(hai_core::Error::UnsupportedPlatform(_)))
}

/// Get the release for the same board used by UTM downloads.
#[tauri::command]
pub async fn get_utm_haos_release() -> Result<HaosRelease, CommandError> {
    release_for_selection(&Backend, None, Some(utm_board()?)).await
}

/// Download the HAOS qcow2 image for UTM
#[tauri::command]
pub async fn download_utm_image(
    attempt: String,
    progress_channel: Channel<FlashProgress>,
    pending: tauri::State<'_, PendingUtmImages>,
    jobs: tauri::State<'_, InstallJobs>,
) -> Result<String, CommandError> {
    let job = jobs.begin(attempt);
    let _running = running_job();
    let _awake = keep_awake("Downloading Home Assistant").await;
    let callback =
        TauriProgressCallback::new(&progress_channel, "utm_download").cancellable(job.cancelled());

    // Verify UTM is available before doing any work.
    if let Err(error) = Backend.check_utm_status().await {
        return callback.operation.finish(Err(CommandError::from(error)));
    }
    // Only a failure finishes the operation here; success waits for the image
    let board = match utm_board() {
        Ok(board) => board,
        Err(error) => return callback.operation.finish(Err(error)),
    };
    let image = callback
        .operation
        .finish(run_utm_download(&Backend, board, &callback).await)?;
    let path = image.to_string_lossy().into_owned();
    pending.insert(path.clone());
    Ok(path)
}

/// Download and extract the HAOS qcow2 image for `arch`, returning the extracted path.
///
/// Generic over the backend so it can be exercised against `BackendMock`.
async fn run_utm_download<B, P>(
    backend: &B,
    arch: &str,
    callback: &P,
) -> Result<std::path::PathBuf, CommandError>
where
    B: ReleaseSource,
    P: ProgressCallback,
{
    callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Fetching release info...".to_string(),
    });

    let release = backend
        .get_latest_haos_release_for_board(arch)
        .await
        .map_err(CommandError::from)?;

    let image = release.image_for(arch, ImageFormat::Qcow2).ok_or_else(|| {
        hai_core::Error::InvalidConfig("No compatible virtual-machine image was found.".into())
    })?;

    let path = hai_core::download::fetch_image(backend, image, callback)
        .await
        .map_err(CommandError::from)?;

    callback.on_progress(FlashProgress {
        stage: FlashStage::Complete,
        progress: 100,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Download complete!".to_string(),
    });

    Ok(path)
}

/// Forget a downloaded image abandoned before VM creation. The file stays for
/// a retry; the cache folder is cleared when the installer closes.
#[tauri::command]
pub fn discard_utm_image(image_path: String, pending: tauri::State<'_, PendingUtmImages>) {
    pending.take(&image_path);
}

/// Check if UTM is installed and get its status
#[tauri::command]
pub async fn check_utm_status() -> Result<hai_core::UtmStatus, CommandError> {
    Backend
        .check_utm_status()
        .await
        .map_err(CommandError::from_query)
}

/// Ask macOS whether the installer may control UTM, before anything is
/// downloaded. The first time, this shows the Automation prompt.
#[tauri::command(async)]
pub fn check_utm_automation() -> Result<(), CommandError> {
    UtmBackend::check_automation(&Backend).map_err(CommandError::from_query)
}

/// Create a Home Assistant VM in UTM
#[tauri::command]
pub async fn create_utm_vm(
    config: hai_core::UtmVmConfig,
    pending: tauri::State<'_, PendingUtmImages>,
) -> Result<String, CommandError> {
    let _running = running_job();
    let _awake = keep_awake("Creating the Home Assistant virtual machine").await;
    Operation::new("utm_create").finish(run_utm_creation(&Backend, &config, &pending).await)
}

async fn run_utm_creation<B: UtmBackend>(
    backend: &B,
    config: &hai_core::UtmVmConfig,
    pending: &PendingUtmImages,
) -> Result<String, CommandError> {
    if !pending.take(&config.image_path) {
        return Err(CommandError::with_message(
            "temporary_image_unavailable",
            &hai_core::message!("backend.utm.temporary_image_gone"),
            true,
        ));
    }
    // Fully qualified: `create_vm` is defined on both UtmBackend and ProxmoxBackend.
    let result = UtmBackend::create_vm(backend, config, &hai_core::NoOpProgress).await;
    if let Err(hai_core::Error::UtmOperationUncertain(error)) = &result {
        return Err(CommandError::with_message(
            "utm_operation_uncertain",
            &hai_core::message!("backend.utm.import_uncertain", detail = error),
            false,
        ));
    }
    result.map(|result| result.id).map_err(CommandError::from)
}

/// Start a UTM VM
#[tauri::command(async)]
pub fn start_utm_vm(vm_id: String) -> Result<(), CommandError> {
    Operation::new("utm_start").finish(Backend.start_vm(&vm_id).map_err(CommandError::from))
}

/// Get the status of a UTM VM
#[tauri::command(async)]
pub fn get_utm_vm_status(vm_id: String) -> Result<VmStatusInfo, CommandError> {
    // Fully qualified: `vm_status` is defined on both UtmBackend and ProxmoxBackend.
    UtmBackend::vm_status(&Backend, &vm_id).map_err(CommandError::from)
}

// =============================================================================
// HA Status Commands
// =============================================================================

/// Check if Home Assistant webserver is ready
#[tauri::command]
pub async fn check_ha_ready(ip_address: String) -> bool {
    Backend.check_ha_ready(&ip_address).await
}

/// Check if Home Assistant has finished updating
#[tauri::command]
pub async fn check_ha_updated(ip_address: String) -> bool {
    Backend.check_ha_updated(&ip_address).await
}

/// What Supervisor reports while it installs Home Assistant, or `None`
/// without a full answer from the landing page
#[tauri::command]
pub async fn get_ha_setup_status(ip_address: String) -> Option<HaSetupStatus> {
    let status = Backend.ha_setup_status(&ip_address).await;
    if let Some(status) = &status {
        crate::diagnostics::setup_status(status);
    }
    status
}

/// The Home Assistants that announce themselves on the local network
#[tauri::command]
pub async fn find_home_assistants() -> Result<Vec<HaAnnouncement>, CommandError> {
    let found = Backend
        .find_home_assistants()
        .await
        .map_err(CommandError::from_query);
    crate::diagnostics::lookup(&found);
    found
}

// =============================================================================
// Proxmox Commands
// =============================================================================

/// Inspect server trust without sending credentials or an HTTP request.
///
/// `None` means the platform trusts the certificate. A fingerprint means it
/// does not, and the user has to confirm it before any credentials are sent.
#[tauri::command]
pub async fn proxmox_certificate_fingerprint(
    server_url: String,
) -> Result<Option<String>, CommandError> {
    Operation::new("proxmox_certificate").finish(
        Backend
            .certificate_fingerprint(&server_url)
            .await
            .map_err(CommandError::from),
    )
}

/// Connect to a Proxmox VE server
#[tauri::command]
pub async fn proxmox_connect(
    credentials: ProxmoxCredentials,
) -> Result<ProxmoxSession, CommandError> {
    Operation::new("proxmox_connect").finish(
        Backend
            .authenticate(&credentials)
            .await
            .map_err(CommandError::from),
    )
}

/// List available nodes on Proxmox
#[tauri::command]
pub async fn proxmox_list_nodes(session: ProxmoxSession) -> Result<Vec<ProxmoxNode>, CommandError> {
    Backend
        .list_nodes(&session)
        .await
        .map_err(CommandError::from_query)
}

/// List available storage on a Proxmox node
#[tauri::command]
pub async fn proxmox_list_storage(
    session: ProxmoxSession,
    node: String,
) -> Result<Vec<ProxmoxStorage>, CommandError> {
    Backend
        .list_storage(&session, &node)
        .await
        .map_err(CommandError::from_query)
}

/// List bridges and SDN VNets available on a Proxmox node.
#[tauri::command]
pub async fn proxmox_list_bridges(
    session: ProxmoxSession,
    node: String,
) -> Result<Vec<ProxmoxBridge>, CommandError> {
    Backend
        .list_bridges(&session, &node)
        .await
        .map_err(CommandError::from_query)
}

/// Explicitly enable import content on an active directory storage.
///
/// Only called after the user agreed to the cluster-wide change. Returns
/// whether this call changed the storage, so the frontend can remind the user.
#[tauri::command]
pub async fn proxmox_enable_storage_import(
    session: ProxmoxSession,
    node: String,
    storage: String,
) -> Result<bool, CommandError> {
    Operation::new("proxmox_enable_import").finish(
        Backend
            .enable_storage_import(&session, &node, &storage)
            .await
            .map_err(CommandError::from),
    )
}

/// Get the next available VM ID on Proxmox
#[tauri::command]
pub async fn proxmox_get_next_vm_id(session: ProxmoxSession) -> Result<u32, CommandError> {
    Backend
        .get_next_vm_id(&session)
        .await
        .map_err(CommandError::from_query)
}

/// Run the checks a Proxmox install starts with, before the user confirms it
#[tauri::command]
pub async fn proxmox_check_vm_config(
    session: ProxmoxSession,
    config: ProxmoxVmConfig,
) -> Result<(), CommandError> {
    Backend
        .check_vm_config(&session, &config)
        .await
        .map_err(CommandError::from_query)
}

/// Create a Home Assistant VM on Proxmox
#[tauri::command]
pub async fn proxmox_create_vm(
    session: ProxmoxSession,
    config: ProxmoxVmConfig,
    attempt: String,
    progress_channel: Channel<FlashProgress>,
    jobs: tauri::State<'_, InstallJobs>,
) -> Result<ProxmoxVmResult, CommandError> {
    let job = jobs.begin(attempt);
    let _running = running_job();
    let _awake = keep_awake("Installing Home Assistant on Proxmox").await;
    let callback = TauriProgressCallback::new(&progress_channel, "proxmox_install")
        .cancellable(job.cancelled());
    callback
        .operation
        .finish(run_proxmox_install(&Backend, &session, &config, &callback).await)
}

/// Passes progress on, and notes when the install starts to create the VM.
struct VmCreationWatch<'a, P> {
    progress: &'a P,
    creating: AtomicBool,
}

impl<P: ProgressCallback> ProgressCallback for VmCreationWatch<'_, P> {
    fn on_progress(&self, progress: FlashProgress) {
        if matches!(
            progress.stage,
            FlashStage::CreatingVm | FlashStage::StartingVm
        ) {
            self.creating.store(true, Ordering::Release);
        }
        self.progress.on_progress(progress);
    }

    fn is_cancelled(&self) -> bool {
        self.progress.is_cancelled()
    }
}

/// Run a Proxmox install, and say whether trying it again is safe.
async fn run_proxmox_install<B: ProxmoxBackend, P: ProgressCallback>(
    backend: &B,
    session: &ProxmoxSession,
    config: &ProxmoxVmConfig,
    progress: &P,
) -> Result<ProxmoxVmResult, CommandError> {
    let watch = VmCreationWatch {
        progress,
        creating: AtomicBool::new(false),
    };
    // Fully qualified: `create_vm` is defined on both ProxmoxBackend and UtmBackend.
    ProxmoxBackend::create_vm(backend, session, config, &watch)
        .await
        .map_err(|error| {
            // Before the VM is being created, the install has only looked
            // things up and uploaded an image under a name no other attempt
            // uses, so it can be tried again like a lookup: after a lost
            // connection, or once the user has freed the VM ID or storage.
            if !watch.creating.load(Ordering::Acquire) {
                return CommandError::from_query(error);
            }
            let mut error = CommandError::from(error);
            // A lost response may leave a VM behind. This command cannot yet
            // resume it safely, even when the underlying network error is transient.
            // A stop never gets that far, so trying again is fine.
            if error.code != "cancelled" {
                error.retryable = false;
            }
            error
        })
}

/// Stop the Proxmox install or UTM download that `attempt` names. It ends
/// with a `cancelled` error. Once the virtual machine is being created, it
/// runs to the end instead.
#[tauri::command]
pub fn cancel_vm_install(attempt: String, jobs: tauri::State<'_, InstallJobs>) {
    jobs.cancel(&attempt);
}

/// Get the run status and IP address of a Proxmox VM
#[tauri::command]
pub async fn proxmox_get_vm_status(
    session: ProxmoxSession,
    node: String,
    vm_id: u32,
) -> Result<VmStatusInfo, CommandError> {
    // Fully qualified: `vm_status` is defined on both ProxmoxBackend and UtmBackend.
    ProxmoxBackend::vm_status(&Backend, &session, &node, vm_id)
        .await
        .map_err(CommandError::from_query)
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_unsupported_platform_marks_utm_unsupported() {
        assert!(supports_utm(Ok(())));
        assert!(!supports_utm(Err(hai_core::Error::UnsupportedPlatform(
            "UTM installs need a Mac with Apple silicon".into()
        ))));
        assert!(supports_utm(Err(hai_core::Error::InvalidConfig(
            "Rosetta status unknown".into()
        ))));
    }

    #[tokio::test]
    async fn test_proxmox_certificate_rejects_http() {
        let result = proxmox_certificate_fingerprint("http://127.0.0.1:1".into()).await;
        assert!(result.unwrap_err().message.contains("HTTPS"));
    }

    #[cfg(not(feature = "mock"))]
    #[tokio::test]
    async fn test_proxmox_certificate_policy_applies_to_direct_login_and_session_commands() {
        let credentials = ProxmoxCredentials {
            server_url: "http://127.0.0.1:1".into(),
            username: "fixture".into(),
            password: "fixture".into(),
            totp: None,
            certificate_sha256: None,
        };
        assert!(proxmox_connect(credentials)
            .await
            .unwrap_err()
            .message
            .contains("HTTPS"));
        let session = ProxmoxSession {
            server_url: "http://127.0.0.1:1".into(),
            ticket: "fixture".into(),
            csrf_token: "fixture".into(),
            certificate_sha256: None,
        };
        for result in [
            proxmox_list_nodes(session.clone()).await.map(drop),
            proxmox_list_storage(session.clone(), "pve".into())
                .await
                .map(drop),
            proxmox_get_next_vm_id(session).await.map(drop),
        ] {
            assert!(result.unwrap_err().message.contains("HTTPS"));
        }
    }

    // The release lookup would go to the internet and the session's plain
    // HTTP would be refused; the disk size is checked before either.
    #[cfg(not(feature = "mock"))]
    #[tokio::test]
    async fn proxmox_check_vm_config_refuses_a_too_small_disk_before_any_lookup() {
        let session = ProxmoxSession {
            server_url: "http://127.0.0.1:1".into(),
            ticket: "fixture".into(),
            csrf_token: "fixture".into(),
            certificate_sha256: None,
        };
        let config = ProxmoxVmConfig {
            node: "pve".into(),
            storage: "local-lvm".into(),
            bridge: "vmbr0".into(),
            vlan_tag: None,
            vm_id: 100,
            name: "homeassistant".into(),
            cpu_cores: 2,
            memory_mb: 4096,
            disk_size_gb: 16,
        };
        let error = proxmox_check_vm_config(session, config).await.unwrap_err();

        assert_eq!(error.code, "proxmox_action_required");
        assert_eq!(
            error.details["message_key"],
            "backend.proxmox.disk_too_small"
        );
    }

    // The configure view picks Retry or Reconnect from the code, so a failed
    // bridge lookup must reach it as a structured error, not a bare string.
    #[cfg(not(feature = "mock"))]
    #[tokio::test]
    async fn proxmox_list_bridges_returns_a_structured_lookup_error() {
        let session = ProxmoxSession {
            server_url: "http://127.0.0.1:1".into(),
            ticket: "fixture".into(),
            csrf_token: "fixture".into(),
            certificate_sha256: None,
        };
        let error = proxmox_list_bridges(session, "pve".into())
            .await
            .unwrap_err();

        assert_eq!(error.code, "proxmox_action_required");
        assert!(error.message.contains("HTTPS"), "{}", error.message);
    }

    #[cfg(feature = "mock")]
    #[tokio::test]
    async fn test_proxmox_certificate_mock_does_not_connect() {
        assert_eq!(
            proxmox_certificate_fingerprint("https://127.0.0.1:1".into())
                .await
                .unwrap(),
            None
        );
    }

    #[cfg(feature = "mock")]
    #[tokio::test]
    #[serial_test::serial]
    async fn utm_download_logs_success_only_after_download_completes() {
        use tauri::Manager;

        // The tail is shared, so an earlier UTM test may have left its own success line
        crate::diagnostics::clear_test_log_tail();
        let app = tauri::test::mock_app();
        app.manage(PendingUtmImages::default());
        app.manage(crate::install_jobs::InstallJobs::default());
        let channel = Channel::new(|_| {
            let tail = crate::diagnostics::test_log_tail();
            assert!(!tail
                .iter()
                .any(|line| line.contains("rust utm_download") && line.contains(" success ")));
            Ok(())
        });
        let path = download_utm_image("attempt".into(), channel, app.state(), app.state())
            .await
            .unwrap();
        let tail = crate::diagnostics::test_log_tail();
        assert_eq!(
            tail.iter()
                .filter(|line| line.contains("rust utm_download") && line.contains(" success "))
                .count(),
            1
        );
        assert!(tail
            .iter()
            .any(|line| line.contains("rust utm_download complete success ")));
        discard_utm_image(path, app.state());
    }

    #[cfg(all(not(feature = "mock"), not(target_os = "macos")))]
    #[tokio::test]
    async fn utm_download_logs_failed_precheck_without_success() {
        use tauri::Manager;

        let app = tauri::test::mock_app();
        app.manage(PendingUtmImages::default());
        app.manage(InstallJobs::default());
        let channel = Channel::new(|_| panic!("An unsupported UTM download must not start"));
        let error = download_utm_image("attempt".into(), channel, app.state(), app.state())
            .await
            .unwrap_err();
        assert_eq!(error.code, "unsupported_platform");
        // The log category is the same fixed code the view receives
        let tail = crate::diagnostics::test_log_tail();
        assert!(tail
            .iter()
            .any(|line| line.contains("rust utm_download preparing unsupported_platform ")));
        assert!(!tail
            .iter()
            .any(|line| line.contains("rust utm_download") && line.contains(" success ")));
    }

    #[test]
    fn proxmox_lookups_keep_session_expiry_as_its_own_code() {
        // The configure step offers Reconnect for this code instead of a retry
        let expired = CommandError::from_query(hai_core::Error::ProxmoxSessionExpired);
        let value = tauri::ipc::InvokeError::from(expired).0;
        assert_eq!(value["code"], "proxmox_session_expired");
        assert_eq!(value["retryable"], false);
        assert!(value["message"].as_str().unwrap().contains("reconnect"));

        let denied =
            CommandError::from_query(hai_core::Error::ProxmoxApi("Access denied".to_string()));
        let value = tauri::ipc::InvokeError::from(denied).0;
        assert_eq!(value["code"], "proxmox_api");
    }

    /// Fails the install with `error` once it has reported `stages`
    struct FailingProxmoxInstall {
        stages: &'static [FlashStage],
        error: fn() -> hai_core::Error,
    }

    impl ProxmoxBackend for FailingProxmoxInstall {
        async fn authenticate(&self, _: &ProxmoxCredentials) -> hai_core::Result<ProxmoxSession> {
            unreachable!()
        }

        async fn list_nodes(&self, _: &ProxmoxSession) -> hai_core::Result<Vec<ProxmoxNode>> {
            unreachable!()
        }

        async fn list_bridges(
            &self,
            _: &ProxmoxSession,
            _: &str,
        ) -> hai_core::Result<Vec<ProxmoxBridge>> {
            unreachable!()
        }

        async fn list_storage(
            &self,
            _: &ProxmoxSession,
            _: &str,
        ) -> hai_core::Result<Vec<ProxmoxStorage>> {
            unreachable!()
        }

        async fn get_next_vm_id(&self, _: &ProxmoxSession) -> hai_core::Result<u32> {
            unreachable!()
        }

        async fn create_vm<P: ProgressCallback>(
            &self,
            _: &ProxmoxSession,
            _: &ProxmoxVmConfig,
            progress: &P,
        ) -> hai_core::Result<ProxmoxVmResult> {
            for stage in self.stages {
                progress.on_progress(FlashProgress {
                    stage: stage.clone(),
                    progress: 0,
                    bytes_processed: 0,
                    total_bytes: 0,
                    message: String::new(),
                });
            }
            Err((self.error)())
        }
    }

    #[tokio::test]
    async fn proxmox_install_keeps_its_retry_until_the_vm_is_being_created() {
        use FlashStage::*;
        let session = ProxmoxSession {
            server_url: "https://proxmox.example:8006".into(),
            ticket: "fixture".into(),
            csrf_token: "fixture".into(),
            certificate_sha256: None,
        };
        let config = ProxmoxVmConfig {
            node: "pve".into(),
            storage: "local-lvm".into(),
            bridge: "vmbr0".into(),
            vlan_tag: None,
            vm_id: 100,
            name: "homeassistant".into(),
            cpu_cores: 2,
            memory_mb: 4096,
            disk_size_gb: 32,
        };
        let vm_id_taken: fn() -> hai_core::Error = || {
            hai_core::Error::ProxmoxActionRequired(hai_core::message!(
                "backend.proxmox.vm_id_unavailable",
                vm_id = 100,
            ))
        };
        let lost_download: fn() -> hai_core::Error =
            || hai_core::Error::DownloadFailed("connection reset".into());
        let lost_response: fn() -> hai_core::Error =
            || hai_core::Error::ProxmoxApi("connection reset".into());
        let expired: fn() -> hai_core::Error = || hai_core::Error::ProxmoxSessionExpired;
        let cases: [(&'static [FlashStage], _, bool); 7] = [
            // Taken by someone else between Confirm and the install's own check
            (&[Downloading], vm_id_taken, true),
            (&[Downloading], lost_download, true),
            (&[Downloading, Extracting, Uploading], lost_response, true),
            // Logging in again gets past this one, not trying again
            (&[Downloading, Extracting, Uploading], expired, false),
            // The VM may exist half way, unknown to the installer
            (
                &[Downloading, Extracting, Uploading, CreatingVm],
                lost_response,
                false,
            ),
            (
                &[Downloading, Extracting, Uploading, CreatingVm],
                vm_id_taken,
                false,
            ),
            (
                &[Downloading, Extracting, Uploading, CreatingVm, StartingVm],
                lost_response,
                false,
            ),
        ];

        for (stages, error, retryable) in cases {
            let backend = FailingProxmoxInstall { stages, error };
            let error = run_proxmox_install(&backend, &session, &config, &hai_core::NoOpProgress)
                .await
                .unwrap_err();
            assert_eq!(
                error.retryable, retryable,
                "{} after {stages:?}",
                error.code
            );
        }
    }

    #[test]
    fn unreachable_services_are_retryable_catalog_messages() {
        let error = CommandError::from_query(hai_core::Error::ServiceUnavailable(
            hai_core::message!("backend.download.version_service_unreachable"),
        ));
        let value = tauri::ipc::InvokeError::from(error).0;
        assert_eq!(value["code"], "network");
        assert_eq!(value["retryable"], true);
        assert_eq!(
            value["details"]["message_key"],
            "backend.download.version_service_unreachable"
        );
        assert!(value["message"]
            .as_str()
            .unwrap()
            .contains("version.home-assistant.io"));
    }

    #[cfg(feature = "mock")]
    #[tokio::test]
    async fn check_connection_uses_mock_backend() {
        assert!(check_connection().await.is_ok());
    }

    #[test]
    fn flash_command_result_keeps_its_wire_shape() {
        // Failures reject the command with a CommandError instead
        let result = FlashResult { duration_secs: 42 };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({"duration_secs": 42})
        );
    }

    #[test]
    fn write_protection_has_a_stable_code() {
        let error = CommandError::from(hai_core::Error::WriteProtected);
        assert_eq!(error.code, "write_protected");
        assert!(!error.retryable);
    }

    #[test]
    fn io_error_does_not_expose_raw_details() {
        let error = CommandError::from(hai_core::Error::Io(std::io::Error::other("boom")));
        assert_eq!(error.code, "io");
        assert!(!error.message.contains("boom"));
    }

    // ===== Manifest Tests =====

    struct SelectionReleaseBackend;

    impl ReleaseSource for SelectionReleaseBackend {
        async fn check_connection(&self) -> hai_core::Result<()> {
            unreachable!("release confirmation must not check connectivity")
        }

        async fn get_device_manifest(&self) -> hai_core::Result<DeviceManifest> {
            unreachable!()
        }

        async fn get_haos_release(&self, version: &str) -> hai_core::Result<HaosRelease> {
            Ok(HaosRelease {
                version: format!("explicit:{version}"),
                images: vec![],
            })
        }

        async fn get_latest_haos_release_for_board(
            &self,
            board: &str,
        ) -> hai_core::Result<HaosRelease> {
            let version = match board {
                "rpi5-64" => "18.3",
                "odroid-n2" => "18.2",
                "ova" => "18.1",
                "generic-aarch64" | "generic-x86-64" => "18.0",
                _ => return Err(hai_core::Error::DownloadFailed("Board unavailable".into())),
            };
            Ok(HaosRelease {
                version: version.into(),
                images: vec![],
            })
        }

        async fn download_image<P: ProgressCallback>(
            &self,
            _: &hai_core::HaosImage,
            _: &std::path::Path,
            _: &P,
        ) -> hai_core::Result<()> {
            unreachable!("confirmation must not download")
        }

        async fn extract_xz<P: ProgressCallback>(
            &self,
            _: &std::path::Path,
            _: &std::path::Path,
            _: &P,
        ) -> hai_core::Result<()> {
            unreachable!("confirmation must not extract")
        }

        fn cache_dir(&self) -> hai_core::Result<std::path::PathBuf> {
            unreachable!("confirmation must not create cache files")
        }
    }

    #[tokio::test]
    async fn confirmation_release_uses_selected_board_in_staged_rollout() {
        for (board, expected) in [
            ("rpi5-64", "18.3"),
            ("odroid-n2", "18.2"),
            ("ova", "18.1"),
            ("generic-aarch64", "18.0"),
        ] {
            for version in [None, Some("latest")] {
                let release = release_for_selection(&SelectionReleaseBackend, version, Some(board))
                    .await
                    .unwrap();
                assert_eq!(release.version, expected);
            }
        }
        let error = release_for_selection(&SelectionReleaseBackend, None, Some("retired-board"))
            .await
            .unwrap_err();
        // Remote details stay out of the error; the code says what happened
        assert_eq!(error.code, "download_failed");
    }

    #[tokio::test]
    async fn confirmation_release_preserves_explicit_versions_and_boardless_calls() {
        for (version, board, expected) in [
            (Some("17.0"), Some("rpi5-64"), "explicit:17.0"),
            (None, None, "explicit:latest"),
        ] {
            assert_eq!(
                release_for_selection(&SelectionReleaseBackend, version, board)
                    .await
                    .unwrap()
                    .version,
                expected
            );
        }
    }

    #[tokio::test]
    #[cfg(feature = "mock")]
    async fn test_get_manifest_returns_ok() {
        let result = get_manifest().await;
        assert!(result.is_ok());
        let manifest = result.unwrap();
        assert!(!manifest.devices.is_empty());
    }

    #[tokio::test]
    #[cfg(feature = "mock")]
    async fn test_get_manifest_has_devices() {
        let result = get_manifest().await;
        assert!(result.is_ok());
        let manifest = result.unwrap();
        assert!(!manifest.devices.is_empty());
        assert!(manifest.version > 0);
    }

    #[tokio::test]
    #[cfg(feature = "mock")]
    async fn test_get_manifest_devices_have_valid_haos_config() {
        let result = get_manifest().await;
        assert!(result.is_ok());
        let manifest = result.unwrap();
        for device in manifest.devices {
            assert!(!device.id.is_empty());
            assert!(!device.name.is_empty());
            assert!(!device.haos.board.is_empty());
        }
    }

    // ===== Non-mock System Info Tests =====

    #[cfg(not(feature = "mock"))] // asserts on the real backend's answers
    #[test]
    #[cfg(target_os = "macos")]
    fn test_system_info_macos_fallback_on_error() {
        let info = get_system_info().unwrap();
        // Real values from sysctl, or the fallback defaults if it fails.
        // Either way they're non-zero; CI runners can have fewer than 4 cores.
        assert!(info.cpu_cores >= 1);
        assert!(info.memory_mb > 0);
    }

    #[cfg(not(feature = "mock"))] // asserts on the real backend's answers
    #[test]
    #[cfg(not(target_os = "macos"))]
    fn test_system_info_non_macos() {
        assert!(get_system_info().is_err());
    }

    // ===== Additional edge case tests =====

    #[test]
    #[cfg(feature = "mock")]
    fn test_start_utm_vm_mock_returns_ok() {
        let result = start_utm_vm("test-vm".to_string());
        assert!(result.is_ok());
    }

    // Off macOS the commands no longer gate themselves; hai-core has to
    // refuse them, and that refusal has to reach the frontend.
    #[cfg(not(feature = "mock"))] // asserts on the real backend's answers
    #[test]
    #[cfg(not(target_os = "macos"))]
    fn test_start_utm_vm_unsupported_off_macos() {
        let err = start_utm_vm("test-vm".to_string()).unwrap_err();
        assert_eq!(err.code, "unsupported_platform");
    }

    #[test]
    #[cfg(feature = "mock")]
    fn test_check_utm_automation_mock_returns_ok() {
        assert!(check_utm_automation().is_ok());
    }

    // Asking again can't change the platform, so the check offers no retry.
    #[cfg(not(feature = "mock"))] // asserts on the real backend's answers
    #[test]
    #[cfg(not(target_os = "macos"))]
    fn test_check_utm_automation_unsupported_off_macos() {
        let err = check_utm_automation().unwrap_err();
        assert_eq!(err.code, "unsupported_platform");
        assert!(!err.retryable);
    }

    #[test]
    #[cfg(feature = "mock")]
    fn test_get_utm_vm_status_mock_returns_running_vm() {
        let result = get_utm_vm_status("test-vm".to_string());
        assert!(result.is_ok());
        let status = result.unwrap();
        assert_eq!(status.status, "started");
        assert_eq!(status.ip_address.as_deref(), Some("192.168.1.100"));
    }

    // ===== check_ha_ready() Tests =====

    /// The setup statuses recorded in the shared diagnostics tail.
    #[cfg(not(feature = "mock"))]
    fn setup_status_lines() -> Vec<String> {
        crate::diagnostics::test_log_tail()
            .into_iter()
            .filter(|line| line.contains(" supervisor "))
            .collect()
    }

    #[cfg(not(feature = "mock"))] // asserts on the real backend's answers
    #[tokio::test]
    // Isolated from other tests that clear the tail or record setup statuses
    #[serial_test::serial]
    async fn ha_setup_status_forwards_a_full_answer_and_records_only_its_categories() {
        crate::diagnostics::clear_test_log_tail();
        let mut server = mockito::Server::new_async().await;
        for (path, data) in [
            (
                "jobs",
                r#"{"jobs":[{"name":"home_assistant_core_install","progress":42.5}]}"#,
            ),
            (
                "network",
                r#"{"host_internet":false,"supervisor_internet":false}"#,
            ),
            (
                "resolution",
                r#"{"issues":[{"type":"update_failed","context":"supervisor","reference":"2026.10.3","uuid":"private-uuid"}]}"#,
            ),
        ] {
            server
                .mock("GET", format!("/supervisor-api/{path}/info").as_str())
                .with_body(format!(r#"{{"result":"ok","data":{data}}}"#))
                .create_async()
                .await;
        }

        assert_eq!(
            get_ha_setup_status(server.host_with_port()).await,
            Some(HaSetupStatus {
                core_install_progress: Some(42.5),
                supervisor_update_progress: None,
                problems: vec![
                    hai_core::HaSetupProblem::NoInternet,
                    hai_core::HaSetupProblem::UpdateFailed,
                ],
            })
        );
        let lines = setup_status_lines();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(
            lines[0].ends_with(
                "supervisor self_update=none core_install=25% problems=[NoInternet, UpdateFailed]"
            ),
            "{lines:?}"
        );
        // Never the address, or Supervisor's references
        let tail = crate::diagnostics::test_log_tail().join("\n");
        for private in [
            server.host_with_port().as_str(),
            "2026.10.3",
            "private-uuid",
        ] {
            assert!(!tail.contains(private), "{tail}");
        }
    }

    #[cfg(not(feature = "mock"))] // asserts on the real backend's answers
    #[tokio::test]
    #[serial_test::serial]
    async fn ha_setup_status_without_a_full_answer_is_none_and_records_nothing() {
        crate::diagnostics::clear_test_log_tail();
        // Only the network answers, as while Supervisor restarts
        let mut partial = mockito::Server::new_async().await;
        partial
            .mock("GET", "/supervisor-api/network/info")
            .with_body(r#"{"result":"ok","data":{"host_internet":false}}"#)
            .create_async()
            .await;
        assert_eq!(get_ha_setup_status(partial.host_with_port()).await, None);

        // And once Core runs, nothing answers
        let core = mockito::Server::new_async().await;
        assert_eq!(get_ha_setup_status(core.host_with_port()).await, None);

        assert!(setup_status_lines().is_empty());
    }

    #[cfg(feature = "mock")]
    #[tokio::test]
    // Isolated from other tests that clear the tail or record lookups
    #[serial_test::serial]
    async fn find_home_assistants_forwards_a_lookup_and_records_only_its_counts() {
        crate::diagnostics::clear_test_log_tail();

        // The mock finds a landing page each lookup didn't before
        let found = find_home_assistants().await.unwrap();
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].landing_page);
        assert_eq!(found[0].address, "192.168.1.101");

        let tail = crate::diagnostics::test_log_tail().join("\n");
        assert!(
            tail.contains(" home_assistant_lookup found=1 landing_pages=1"),
            "{tail}"
        );
        // Never which one, or where
        for private in [found[0].id.as_str(), found[0].address.as_str()] {
            assert!(!tail.contains(private), "{tail}");
        }
    }

    #[cfg(feature = "mock")]
    #[tokio::test]
    async fn ha_setup_status_mock_has_no_landing_page() {
        // The mock's Home Assistant is ready at once, so its landing page is gone
        assert_eq!(get_ha_setup_status("192.168.1.100".into()).await, None);
    }

    #[cfg(not(feature = "mock"))] // asserts on the real backend's answers
    #[tokio::test]
    async fn ha_checks_tell_a_web_server_from_a_started_home_assistant() {
        let mut server = mockito::Server::new_async().await;
        let _root = server.mock("GET", "/").create_async().await;
        let starting = server
            .mock("GET", "/manifest.json")
            .with_status(404)
            .create_async()
            .await;
        // Any answer means the web server is up; only the manifest means Home Assistant started
        assert!(check_ha_ready(server.host_with_port()).await);
        assert!(!check_ha_updated(server.host_with_port()).await);

        starting.remove_async().await;
        let _started = server.mock("GET", "/manifest.json").create_async().await;
        assert!(check_ha_updated(server.host_with_port()).await);
    }

    // ===== Additional Edge Cases =====

    fn flash_target(id: &str, removable: bool) -> BlockDevice {
        BlockDevice {
            id: id.to_string(),
            name: "Test Device".to_string(),
            size: 32_000_000_000,
            device_type: hai_core::DeviceType::UsbDrive,
            removable,
            model: None,
            vendor: None,
            serial: None,
        }
    }

    /// The identity the frontend sends for a device built by `flash_target`.
    fn expected() -> ExpectedDevice {
        ExpectedDevice {
            size: Some(32_000_000_000),
            ..Default::default()
        }
    }

    #[test]
    fn test_find_flash_target_accepts_removable_device() {
        let devices = [flash_target("/dev/sdb", true)];
        let device = find_flash_target(&devices, "/dev/sdb", &expected(), "rpi5-64").unwrap();
        assert_eq!(device.id, "/dev/sdb");
    }

    #[test]
    fn test_find_flash_target_accepts_newly_discovered_serial() {
        let mut device = flash_target("/dev/sdb", true);
        device.serial = Some("STICK-A".into());
        assert!(find_flash_target(&[device.clone()], "/dev/sdb", &expected(), "rpi5-64").is_ok());
        device.model = Some("Different model".into());
        assert!(find_flash_target(&[device], "/dev/sdb", &expected(), "rpi5-64").is_err());
    }

    #[test]
    fn test_find_flash_target_checks_serial_even_for_identical_models() {
        let mut device = flash_target("/dev/sdb", true);
        let expected = ExpectedDevice {
            serial: Some("STICK-A".into()),
            ..expected()
        };
        for serial in [None, Some("STICK-B".into())] {
            device.serial = serial;
            assert!(
                find_flash_target(&[device.clone()], "/dev/sdb", &expected, "rpi5-64").is_err()
            );
        }
        device.serial = expected.serial.clone();
        assert!(find_flash_target(&[device], "/dev/sdb", &expected, "rpi5-64").is_ok());
    }

    #[test]
    fn test_find_flash_target_rejects_unknown_device() {
        let devices = [flash_target("/dev/sdb", true)];
        let err = find_flash_target(&devices, "/dev/sdz", &expected(), "rpi5-64").unwrap_err();
        assert_eq!(err.code, "device_not_found");
    }

    #[test]
    fn test_find_flash_target_rejects_non_removable_device() {
        let devices = [flash_target("\\\\.\\PhysicalDrive1", false)];
        let err = find_flash_target(&devices, "\\\\.\\PhysicalDrive1", &expected(), "rpi5-64")
            .unwrap_err();
        assert_eq!(err.code, "drive_in_system_use");
    }

    #[test]
    fn test_find_flash_target_rejects_empty_device_id() {
        let devices = [flash_target("/dev/sdb", true)];
        let err = find_flash_target(&devices, "", &expected(), "rpi5-64").unwrap_err();
        assert_eq!(err.code, "device_not_found");
    }

    #[test]
    fn test_find_flash_target_rejects_different_device_at_same_path() {
        let mut device = flash_target("/dev/sdb", true);
        device.model = Some("Extreme".to_string());
        let err = find_flash_target(&[device], "/dev/sdb", &expected(), "rpi5-64").unwrap_err();
        assert!(
            err.message.contains("no longer the one you selected"),
            "{err}"
        );
    }

    #[test]
    fn test_find_flash_target_rejects_unknown_expected_size() {
        let devices = [flash_target("/dev/sdb", true)];
        let unknown = ExpectedDevice::default();
        assert!(find_flash_target(&devices, "/dev/sdb", &unknown, "rpi5-64").is_err());
    }

    #[test]
    fn test_find_flash_target_enforces_nominal_board_minimum() {
        for size in [
            8_000_000_000,
            15_199_999_999,
            15_200_000_000,
            15_600_000_000,
            15_931_539_456,
            16_000_000_000,
        ] {
            let mut device = flash_target("/dev/sdb", true);
            device.size = size;
            let expected = ExpectedDevice {
                size: Some(size),
                ..Default::default()
            };
            let devices = [device];
            let result = find_flash_target(&devices, "/dev/sdb", &expected, "rpi5-64");
            if size < 15_200_000_000 {
                let error = result.unwrap_err();
                assert_eq!(error.code, "drive_too_small");
                assert!(error.message.contains("16 GB"), "{error}");
            } else {
                assert!(result.is_ok(), "{size}: {result:?}");
            }
        }
    }

    #[test]
    fn test_find_flash_target_accepts_small_drives_for_installers() {
        for board in ["green-installer", "yellow-installer"] {
            for (size, accepted) in [
                (949_999_999, false),
                (950_000_000, true),
                (8_000_000_000, true),
            ] {
                let mut device = flash_target("/dev/sdb", true);
                device.size = size;
                let expected = ExpectedDevice {
                    size: Some(size),
                    ..Default::default()
                };
                let result = find_flash_target(&[device], "/dev/sdb", &expected, board).map(|_| ());
                if accepted {
                    assert!(result.is_ok(), "{board} {size}: {result:?}");
                } else {
                    let error = result.unwrap_err();
                    assert_eq!(error.code, "drive_too_small");
                    assert!(error.message.contains("1 GB"), "{error}");
                }
            }
        }
    }

    #[test]
    fn test_find_flash_target_rejects_missing_board_requirements() {
        let devices = [flash_target("/dev/sdb", true)];
        let error =
            find_flash_target(&devices, "/dev/sdb", &expected(), "unknown-board").unwrap_err();
        assert!(error.message.contains("No storage requirements"), "{error}");
    }

    struct PreflightBackend {
        check: fn() -> hai_core::Result<()>,
    }

    impl DeviceBackend for PreflightBackend {
        fn check_write_privileges(&self) -> hai_core::Result<()> {
            (self.check)()
        }

        async fn list_devices(&self) -> hai_core::Result<Vec<BlockDevice>> {
            panic!("must not enumerate devices");
        }

        async fn write_image<P: ProgressCallback>(
            &self,
            _: &hai_core::disk::Image,
            _: &str,
            _: &hai_core::ExpectedDevice,
            _: bool,
            _: &P,
        ) -> hai_core::Result<()> {
            panic!("must not write a drive");
        }
    }

    impl ReleaseSource for PreflightBackend {
        async fn check_connection(&self) -> hai_core::Result<()> {
            panic!("must not check connectivity during flashing");
        }

        async fn get_device_manifest(&self) -> hai_core::Result<DeviceManifest> {
            panic!("must not fetch a manifest");
        }

        async fn get_haos_release(&self, _: &str) -> hai_core::Result<HaosRelease> {
            panic!("must not fetch a release by version");
        }

        async fn get_latest_haos_release_for_board(
            &self,
            _: &str,
        ) -> hai_core::Result<HaosRelease> {
            Err(hai_core::Error::InvalidConfig(
                "release lookup reached".into(),
            ))
        }

        async fn download_image<P: ProgressCallback>(
            &self,
            _: &hai_core::HaosImage,
            _: &std::path::Path,
            _: &P,
        ) -> hai_core::Result<()> {
            panic!("must not download an image");
        }

        async fn extract_xz<P: ProgressCallback>(
            &self,
            _: &std::path::Path,
            _: &std::path::Path,
            _: &P,
        ) -> hai_core::Result<()> {
            panic!("must not extract an image");
        }

        fn cache_dir(&self) -> hai_core::Result<std::path::PathBuf> {
            panic!("must not create a cache directory");
        }
    }

    struct NoProgressExpected;

    impl ProgressCallback for NoProgressExpected {
        fn on_progress(&self, _: FlashProgress) {
            panic!("must not report progress");
        }
    }

    #[tokio::test]
    async fn drives_are_not_listed_without_write_privileges() {
        fn not_elevated() -> hai_core::Result<()> {
            Err(hai_core::Error::PermissionDenied(hai_core::message!(
                "backend.disk.run_as_administrator"
            )))
        }
        fn query_failed() -> hai_core::Result<()> {
            Err(hai_core::Error::Io(std::io::Error::other(
                "token query failed",
            )))
        }

        for check in [not_elevated, query_failed] {
            let error = list_drives(&PreflightBackend { check }).await.unwrap_err();
            assert_eq!(error, CommandError::from(check().unwrap_err()));
            // Only restarting the app helps
            assert!(!error.retryable);
        }
    }

    #[tokio::test]
    async fn wifi_is_refused_before_anything_is_downloaded() {
        for (board, password) in [("green-installer", "12345678"), ("rpi5-64", "short")] {
            let request = FlashRequest {
                device_id: "unused-device".into(),
                board: board.into(),
                verify: true,
                expected_device: ExpectedDevice::default(),
                wifi: Some(hai_core::WifiConfig {
                    ssid: "Home".into(),
                    password: password.into(),
                }),
            };
            let backend = PreflightBackend { check: || Ok(()) };
            let error = run_flash(&backend, &request, &NoProgressExpected)
                .await
                .unwrap_err();
            assert_eq!(error.code, "invalid_config", "{board}: {error}");
        }
    }
}

#[cfg(all(test, feature = "mock"))]
mod mock_tests {
    use super::*;
    use hai_core::{BackendMock, NoOpProgress};
    use serial_test::serial;

    /// Images stay in the mock cache like in a session; a test that needs a
    /// download starts without them.
    fn clear_mock_cache() {
        hai_core::download::clear_cache(&BackendMock.cache_dir().unwrap()).unwrap();
    }

    struct LifecycleBackend {
        cache: tempfile::TempDir,
        outcome: &'static str,
        extracted: std::sync::Mutex<Option<std::path::PathBuf>>,
        write_started: tokio::sync::Notify,
        downloads: std::sync::atomic::AtomicUsize,
    }

    impl LifecycleBackend {
        fn new(outcome: &'static str) -> Self {
            Self {
                cache: tempfile::tempdir().unwrap(),
                outcome,
                extracted: Default::default(),
                write_started: Default::default(),
                downloads: Default::default(),
            }
        }

        /// Everything left in the cache folder.
        fn cached(&self) -> Vec<std::path::PathBuf> {
            std::fs::read_dir(self.cache.path())
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect()
        }
    }

    impl ReleaseSource for LifecycleBackend {
        async fn check_connection(&self) -> hai_core::Result<()> {
            panic!("must not check connectivity during installation");
        }

        async fn get_device_manifest(&self) -> hai_core::Result<DeviceManifest> {
            BackendMock.get_device_manifest().await
        }
        async fn get_haos_release(&self, version: &str) -> hai_core::Result<HaosRelease> {
            BackendMock.get_haos_release(version).await
        }
        async fn get_latest_haos_release_for_board(
            &self,
            board: &str,
        ) -> hai_core::Result<HaosRelease> {
            // A checksum, as real releases have, so the session keeps the image
            let mut release = BackendMock.get_latest_haos_release_for_board(board).await?;
            for image in &mut release.images {
                image.digest = Some(format!("sha256:{}", "ab".repeat(32)));
            }
            Ok(release)
        }
        async fn download_image<P: ProgressCallback>(
            &self,
            _: &hai_core::HaosImage,
            dest: &std::path::Path,
            _: &P,
        ) -> hai_core::Result<()> {
            self.downloads.fetch_add(1, Ordering::SeqCst);
            std::fs::write(dest, b"archive")?;
            Ok(())
        }
        async fn extract_xz<P: ProgressCallback>(
            &self,
            archive: &std::path::Path,
            dest: &std::path::Path,
            _: &P,
        ) -> hai_core::Result<()> {
            *self.extracted.lock().unwrap() = Some(dest.to_path_buf());
            // Like the real one: the archive goes, the image only appears complete
            std::fs::remove_file(archive)?;
            if self.outcome == "extract" {
                return Err(hai_core::Error::ExtractionFailed(
                    "test extraction failure".into(),
                ));
            }
            std::fs::write(dest, b"image")?;
            Ok(())
        }
        fn cache_dir(&self) -> hai_core::Result<std::path::PathBuf> {
            Ok(self.cache.path().to_path_buf())
        }
    }

    impl DeviceBackend for LifecycleBackend {
        async fn list_devices(&self) -> hai_core::Result<Vec<BlockDevice>> {
            let mut devices = BackendMock.list_devices().await?;
            if self.outcome == "oversized" {
                for device in &mut devices {
                    device.size = 4;
                }
            }
            Ok(devices)
        }
        async fn write_image<P: ProgressCallback>(
            &self,
            image: &hai_core::disk::Image,
            _: &str,
            _: &hai_core::ExpectedDevice,
            _: bool,
            _: &P,
        ) -> hai_core::Result<()> {
            assert_ne!(
                self.outcome, "oversized",
                "oversized image reached disk writer"
            );
            assert_eq!(std::fs::read(image.path()).unwrap(), b"image");
            match self.outcome {
                "write" => Err(hai_core::Error::Io(std::io::Error::other(
                    "test write failure",
                ))),
                "cancel" => Err(hai_core::Error::Cancelled),
                "suspend" => {
                    self.write_started.notify_one();
                    std::future::pending().await
                }
                _ => Ok(()),
            }
        }
    }

    #[tokio::test]
    async fn flash_keeps_only_a_complete_image_on_every_exit() {
        for outcome in [
            "success",
            "extract",
            "write",
            "cancel",
            "suspend",
            "oversized",
        ] {
            let backend = LifecycleBackend::new(outcome);
            let mut request = request("mock-sd-card-32gb", "rpi5-64").await;
            if outcome == "oversized" {
                request.expected_device.size = Some(4);
            }
            let result = if outcome == "suspend" {
                let flash = run_flash(&backend, &request, &NoOpProgress);
                tokio::pin!(flash);
                tokio::select! {
                    _ = backend.write_started.notified() => None,
                    result = &mut flash => Some(result),
                }
            } else {
                Some(run_flash(&backend, &request, &NoOpProgress).await)
            };
            match outcome {
                "success" => {
                    result.unwrap().unwrap();
                }
                "suspend" => assert!(result.is_none()),
                "cancel" => assert!(result.unwrap().unwrap_err().message.contains("cancelled")),
                "oversized" => {
                    // The board minimum stops a drive this small at the check
                    // before writing; ensure_image_fits has its own tests for
                    // the image size check that follows it.
                    let error = result.unwrap().unwrap_err();
                    assert_eq!(error.code, "drive_too_small");
                    assert!(!error.retryable);
                }
                _ => assert!(result.unwrap().is_err()),
            }
            let path = backend.extracted.lock().unwrap().clone().unwrap();
            let kept: &[_] = if outcome == "extract" { &[] } else { &[path] };
            assert_eq!(backend.cached(), kept, "{outcome}");
        }
    }

    #[tokio::test]
    async fn flash_retry_reuses_the_extracted_image() {
        let backend = LifecycleBackend::new("write");
        let request = request("mock-sd-card-32gb", "rpi5-64").await;
        for _ in 0..2 {
            // The writer checks it gets the extracted image
            assert!(run_flash(&backend, &request, &NoOpProgress).await.is_err());
        }
        assert_eq!(backend.downloads.load(Ordering::SeqCst), 1);
        assert_eq!(backend.cached().len(), 1);
    }

    #[tokio::test]
    async fn utm_retry_reuses_the_extracted_image() {
        let backend = LifecycleBackend::new("success");
        let first = run_utm_download(&backend, "generic-aarch64", &NoOpProgress)
            .await
            .unwrap();
        let second = run_utm_download(&backend, "generic-aarch64", &NoOpProgress)
            .await
            .unwrap();
        assert_eq!(backend.downloads.load(Ordering::SeqCst), 1);
        assert_eq!(first, second);
        assert_eq!(backend.cached(), [first]);
    }

    #[tokio::test]
    async fn utm_download_keeps_only_a_complete_image() {
        for outcome in ["success", "extract"] {
            let backend = LifecycleBackend::new(outcome);
            let result = run_utm_download(&backend, "generic-aarch64", &NoOpProgress).await;
            assert_eq!(result.is_ok(), outcome == "success");
            let kept: Vec<_> = result.into_iter().collect();
            assert_eq!(backend.cached(), kept);
        }
    }

    #[test]
    fn utm_registry_only_accepts_images_it_handed_out() {
        let pending = PendingUtmImages::default();
        assert!(!pending.take("/Users/someone/user.qcow2"));
        pending.insert("/cache/haos.qcow2".into());
        assert!(pending.take("/cache/haos.qcow2"));
        assert!(!pending.take("/cache/haos.qcow2"));
    }

    #[test]
    fn utm_registry_keeps_working_after_a_panic_while_locked() {
        let pending = PendingUtmImages::default();
        let path = "/cache/haos.qcow2".to_string();
        pending.insert(path.clone());
        std::thread::scope(|scope| {
            let panicked = scope.spawn(|| {
                let _images = pending.0.lock().unwrap();
                panic!("panic while the registry is locked");
            });
            assert!(panicked.join().is_err());
        });
        assert!(pending.0.is_poisoned());

        assert!(pending.take(&path));
        pending.insert(path.clone());
        assert!(pending.take(&path));
    }

    struct UtmCreationBackend {
        outcome: &'static str,
        started: tokio::sync::Notify,
    }

    impl UtmBackend for UtmCreationBackend {
        async fn check_utm_status(&self) -> hai_core::Result<hai_core::UtmStatus> {
            unreachable!()
        }

        fn check_automation(&self) -> hai_core::Result<()> {
            unreachable!()
        }

        async fn create_vm<P: ProgressCallback>(
            &self,
            config: &hai_core::UtmVmConfig,
            _: &P,
        ) -> hai_core::Result<hai_core::UtmVmResult> {
            assert!(std::path::Path::new(&config.image_path).exists());
            self.started.notify_one();
            match self.outcome {
                "success" => Ok(hai_core::UtmVmResult {
                    id: "stable-utm-id".into(),
                    name: config.name.clone(),
                    path: None,
                }),
                "rejected" => Err(hai_core::Error::Utm(hai_core::message!(
                    "backend.utm.applescript_error",
                    detail = "Invalid configuration",
                ))),
                "start-failed" => Err(hai_core::Error::UtmVmCreated(hai_core::message!(
                    "backend.utm.vm_created_not_started",
                    name = config.name,
                    detail = "",
                ))),
                "timeout" => Err(hai_core::Error::UtmOperationUncertain(hai_core::message!(
                    "backend.utm.no_answer",
                    detail = "AppleEvent timed out (-1712)",
                ))),
                "transport" => Err(hai_core::Error::UtmOperationUncertain(hai_core::message!(
                    "backend.utm.applescript_lost",
                    detail = "broken pipe",
                ))),
                "cancelled" => std::future::pending().await,
                _ => unreachable!(),
            }
        }

        fn start_vm(&self, _: &str) -> hai_core::Result<()> {
            unreachable!()
        }
        fn vm_status(&self, _: &str) -> hai_core::Result<VmStatusInfo> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn utm_creation_keeps_the_image_for_the_session() {
        for outcome in [
            "success",
            "rejected",
            "start-failed",
            "timeout",
            "transport",
            "cancelled",
        ] {
            let cache = tempfile::tempdir().unwrap();
            let path = cache.path().join("haos_generic-aarch64-17.0.qcow2");
            std::fs::write(&path, b"source image").unwrap();
            let pending = PendingUtmImages::default();
            pending.insert(path.to_string_lossy().into_owned());
            let config = hai_core::UtmVmConfig {
                name: "Test VM".into(),
                image_path: path.to_string_lossy().into_owned(),
                cpu_cores: 2,
                memory_mb: 2048,
                disk_size_gb: 32,
                auto_start: false,
            };
            let backend = UtmCreationBackend {
                outcome,
                started: tokio::sync::Notify::new(),
            };
            if outcome == "cancelled" {
                let creation = run_utm_creation(&backend, &config, &pending);
                tokio::pin!(creation);
                tokio::select! {
                    _ = &mut creation => panic!("Creation must still be pending"),
                    _ = backend.started.notified() => {}
                }
            } else {
                let result = run_utm_creation(&backend, &config, &pending).await;
                assert_eq!(result.is_ok(), outcome == "success", "{outcome}");
                if let Ok(id) = &result {
                    assert_eq!(id, "stable-utm-id");
                    assert_ne!(id, &config.name);
                }
                if matches!(outcome, "timeout" | "transport") {
                    let error = result.as_ref().unwrap_err();
                    assert!(error.message.contains("keep the installer open"));
                    // The frontend translates the sentence and the reason inside it
                    assert_eq!(error.details["message_key"], "backend.utm.import_uncertain");
                    assert_eq!(
                        error.details["message_params"]["detail"]["key"],
                        if outcome == "timeout" {
                            "backend.utm.no_answer"
                        } else {
                            "backend.utm.applescript_lost"
                        }
                    );
                }
                if outcome == "start-failed" {
                    let error = result.as_ref().unwrap_err();
                    assert_eq!(error.code, "utm_vm_created");
                    assert!(!error.retryable);
                    assert!(error.message.contains("Open UTM"));
                    assert_eq!(
                        error.details["message_key"],
                        "backend.utm.vm_created_not_started"
                    );
                }
            }
            // A creation takes the image out of the registry, never off the disk
            assert!(!pending.take(&config.image_path));
            assert!(path.exists(), "{outcome}");
        }
    }

    #[tokio::test]
    async fn a_missing_temporary_image_is_a_catalog_message() {
        let backend = UtmCreationBackend {
            outcome: "success",
            started: tokio::sync::Notify::new(),
        };
        let config = hai_core::UtmVmConfig {
            name: "Test VM".into(),
            image_path: "/nowhere/image.qcow2".into(),
            cpu_cores: 2,
            memory_mb: 2048,
            disk_size_gb: 32,
            auto_start: false,
        };

        let error = run_utm_creation(&backend, &config, &PendingUtmImages::default())
            .await
            .unwrap_err();
        assert_eq!(error.code, "temporary_image_unavailable");
        assert!(error.retryable);
        assert_eq!(
            error.details["message_key"],
            "backend.utm.temporary_image_gone"
        );
    }

    #[tokio::test]
    async fn proxmox_list_bridges_returns_mock_bridge() {
        let session = ProxmoxSession {
            server_url: "https://proxmox.example:8006".to_string(),
            ticket: "mock-ticket".to_string(),
            csrf_token: "mock-csrf-token".to_string(),
            certificate_sha256: None,
        };
        let bridges = proxmox_list_bridges(session, "pve".to_string())
            .await
            .unwrap();

        assert_eq!(bridges.len(), 1);
        assert_eq!(bridges[0].name, "vmbr0");
        assert_eq!(bridges[0].network_type, "bridge");
        assert_eq!(bridges[0].comments, None);
        assert!(bridges[0].vlan_aware);
    }

    #[tokio::test]
    async fn proxmox_get_vm_status_asks_the_proxmox_backend() {
        let session = ProxmoxSession {
            server_url: "https://proxmox.example:8006".to_string(),
            ticket: "mock-ticket".to_string(),
            csrf_token: "mock-csrf-token".to_string(),
            certificate_sha256: None,
        };
        let status = proxmox_get_vm_status(session, "pve".to_string(), 100)
            .await
            .unwrap();

        // UTM reports "started", so this proves the Proxmox backend answered
        assert_eq!(status.status, "running");
        assert_eq!(status.ip_address.as_deref(), Some("192.168.1.100"));
    }

    #[tokio::test]
    async fn enable_import_command_uses_mock_backend() {
        let session = ProxmoxSession {
            server_url: "https://example.invalid:8006".to_string(),
            ticket: "mock-ticket".to_string(),
            csrf_token: "mock-csrf".to_string(),
            certificate_sha256: None,
        };
        assert!(!proxmox_enable_storage_import(
            session.clone(),
            "pve".to_string(),
            "local".to_string()
        )
        .await
        .unwrap());
        let error =
            proxmox_enable_storage_import(session, "pve".to_string(), "local-lvm".to_string())
                .await
                .unwrap_err();
        assert_eq!(error.code, "proxmox_api");
    }

    #[tokio::test]
    async fn proxmox_install_stops_only_for_its_own_attempt() {
        use tauri::Manager;

        let app = tauri::test::mock_app();
        app.manage(InstallJobs::default());
        let stages = Arc::new(std::sync::Mutex::new(Vec::new()));
        let progress = Channel::new({
            let app = app.handle().clone();
            let stages = Arc::clone(&stages);
            move |body| {
                let mut stages = stages.lock().unwrap();
                stages.push(body.deserialize::<FlashProgress>().unwrap().stage);
                // The stop for an earlier attempt arrives late, then this one's
                let attempt = if stages.len() == 1 {
                    "earlier"
                } else {
                    "current"
                };
                cancel_vm_install(attempt.into(), app.state());
                Ok(())
            }
        });
        let session = ProxmoxSession {
            server_url: "https://proxmox.example:8006".to_string(),
            ticket: "mock-ticket".to_string(),
            csrf_token: "mock-csrf-token".to_string(),
            certificate_sha256: None,
        };
        let config = ProxmoxVmConfig {
            node: "pve".into(),
            storage: "local-lvm".into(),
            bridge: "vmbr0".into(),
            vlan_tag: None,
            vm_id: 100,
            name: "homeassistant".into(),
            cpu_cores: 2,
            memory_mb: 4096,
            disk_size_gb: 32,
        };
        let error = proxmox_create_vm(session, config, "current".into(), progress, app.state())
            .await
            .unwrap_err();

        assert_eq!(error.code, "cancelled");
        // Unlike other failures, a stop never leaves a VM behind, so it keeps its retry
        assert!(error.retryable);
        assert_eq!(
            *stages.lock().unwrap(),
            [FlashStage::Downloading, FlashStage::Downloading]
        );
    }

    #[tokio::test]
    async fn list_block_devices_reports_the_device_backends_drives() {
        let ids = |devices: Vec<BlockDevice>| devices.into_iter().map(|d| d.id).collect::<Vec<_>>();
        assert_eq!(
            ids(list_block_devices().await.unwrap()),
            ids(BackendMock.list_devices().await.unwrap())
        );
    }

    /// A request for `device_id` whose `expected_device` matches what the mock
    /// backend enumerates, so the flash-target guard lets it through.
    async fn request(device_id: &str, board: &str) -> FlashRequest {
        let device = BackendMock
            .list_devices()
            .await
            .unwrap()
            .into_iter()
            .find(|d| d.id == device_id)
            .unwrap();
        FlashRequest {
            device_id: device.id,
            board: board.to_string(),
            verify: true,
            expected_device: ExpectedDevice {
                size: Some(device.size),
                model: device.model,
                vendor: device.vendor,
                serial: device.serial,
            },
            wifi: None,
        }
    }

    struct DigestFailureBackend {
        cache: tempfile::TempDir,
    }

    impl ReleaseSource for DigestFailureBackend {
        async fn check_connection(&self) -> hai_core::Result<()> {
            panic!("must not check connectivity during installation");
        }

        async fn get_device_manifest(&self) -> hai_core::Result<hai_core::DeviceManifest> {
            unreachable!()
        }

        async fn get_haos_release(&self, _: &str) -> hai_core::Result<HaosRelease> {
            unreachable!("must use the selected board's release")
        }

        async fn get_latest_haos_release_for_board(
            &self,
            board: &str,
        ) -> hai_core::Result<HaosRelease> {
            BackendMock.get_latest_haos_release_for_board(board).await
        }

        async fn download_image<P: ProgressCallback>(
            &self,
            image: &hai_core::HaosImage,
            _: &std::path::Path,
            _: &P,
        ) -> hai_core::Result<()> {
            assert!(image.download_url.contains(&image.board));
            Err(hai_core::Error::ChecksumMismatch {
                expected: "published digest".into(),
                actual: "tampered digest".into(),
            })
        }

        async fn extract_xz<P: ProgressCallback>(
            &self,
            _: &std::path::Path,
            _: &std::path::Path,
            _: &P,
        ) -> hai_core::Result<()> {
            panic!("unverified image reached extraction")
        }

        fn cache_dir(&self) -> hai_core::Result<std::path::PathBuf> {
            Ok(self.cache.path().to_path_buf())
        }
    }

    impl DeviceBackend for DigestFailureBackend {
        async fn list_devices(&self) -> hai_core::Result<Vec<BlockDevice>> {
            panic!("unverified image reached device preparation")
        }

        async fn write_image<P: ProgressCallback>(
            &self,
            _: &hai_core::disk::Image,
            _: &str,
            _: &hai_core::ExpectedDevice,
            _: bool,
            _: &P,
        ) -> hai_core::Result<()> {
            panic!("unverified image reached the writer")
        }
    }

    #[tokio::test]
    async fn digest_failure_stops_flash_and_utm_before_extraction() {
        let backend = DigestFailureBackend {
            cache: tempfile::tempdir().unwrap(),
        };
        let error = run_flash(
            &backend,
            &request("mock-sd-card-32gb", "rpi5-64").await,
            &NoOpProgress,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "checksum_mismatch");
        assert!(error.retryable);
        for board in ["generic-aarch64", "ova"] {
            let error = run_utm_download(&backend, board, &NoOpProgress)
                .await
                .unwrap_err();
            assert_eq!(error.code, "checksum_mismatch");
            assert!(error.retryable);
        }
    }

    #[tokio::test]
    #[serial] // all share the mock cache directory
    async fn flash_command_refuses_a_second_flash_and_stops_for_its_own_cancel() {
        use tauri::Manager;

        let app = tauri::test::mock_app();
        app.manage(FlashState::default());
        let started = Arc::new(tokio::sync::Notify::new());
        let progress = Channel::new({
            let started = Arc::clone(&started);
            move |_| {
                started.notify_one();
                Ok(())
            }
        });
        let first = flash_image(
            request("mock-sd-card-32gb", "rpi5-64").await,
            "first".into(),
            progress,
            app.state(),
        );
        tokio::pin!(first);
        tokio::select! {
            result = &mut first => panic!("The flash must still run: {result:?}"),
            _ = started.notified() => {}
        }

        let error = flash_image(
            request("mock-sd-card-64gb", "rpi5-64").await,
            "second".into(),
            Channel::new(|_| panic!("A second flash must not start")),
            app.state(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "operation_in_progress");

        cancel_flash("first".into(), app.state());
        assert_eq!(first.await.unwrap_err().code, "cancelled");
    }

    #[tokio::test]
    #[serial] // all share the mock cache directory
    async fn run_flash_completes_against_mock_backend() {
        let result = run_flash(
            &BackendMock,
            &request("mock-sd-card-32gb", "rpi5-64").await,
            &NoOpProgress,
        )
        .await
        .unwrap();
        assert!(result.duration_secs < 60);
    }

    #[tokio::test]
    #[serial]
    async fn run_flash_adds_wifi_against_mock_backend() {
        let mut request = request("mock-sd-card-32gb", "rpi5-64").await;
        request.wifi = Some(hai_core::WifiConfig {
            ssid: "Home".into(),
            password: "12345678".into(),
        });
        run_flash(&BackendMock, &request, &NoOpProgress)
            .await
            .unwrap();
    }

    /// Delegates to the mock, but fails any release lookup and records what
    /// was downloaded.
    #[derive(Default)]
    struct PinnedInstallerBackend {
        downloaded: std::sync::Mutex<Option<hai_core::HaosImage>>,
    }

    impl ReleaseSource for PinnedInstallerBackend {
        async fn check_connection(&self) -> hai_core::Result<()> {
            panic!("must not check connectivity during installation");
        }
        async fn get_device_manifest(&self) -> hai_core::Result<DeviceManifest> {
            panic!("must not fetch a manifest");
        }
        async fn get_haos_release(&self, _: &str) -> hai_core::Result<HaosRelease> {
            panic!("an installer must not look up a release");
        }
        async fn get_latest_haos_release_for_board(
            &self,
            _: &str,
        ) -> hai_core::Result<HaosRelease> {
            panic!("an installer must not look up a release");
        }
        async fn download_image<P: ProgressCallback>(
            &self,
            image: &hai_core::HaosImage,
            dest: &std::path::Path,
            callback: &P,
        ) -> hai_core::Result<()> {
            *self.downloaded.lock().unwrap() = Some(image.clone());
            BackendMock.download_image(image, dest, callback).await
        }
        async fn extract_xz<P: ProgressCallback>(
            &self,
            archive: &std::path::Path,
            dest: &std::path::Path,
            callback: &P,
        ) -> hai_core::Result<()> {
            BackendMock.extract_xz(archive, dest, callback).await
        }
        fn cache_dir(&self) -> hai_core::Result<std::path::PathBuf> {
            BackendMock.cache_dir()
        }
    }

    impl DeviceBackend for PinnedInstallerBackend {
        async fn list_devices(&self) -> hai_core::Result<Vec<BlockDevice>> {
            BackendMock.list_devices().await
        }
        async fn write_image<P: ProgressCallback>(
            &self,
            image: &hai_core::disk::Image,
            device_id: &str,
            expected: &hai_core::ExpectedDevice,
            verify: bool,
            callback: &P,
        ) -> hai_core::Result<()> {
            BackendMock
                .write_image(image, device_id, expected, verify, callback)
                .await
        }
    }

    /// Cancels as soon as extraction starts, and records every stage seen.
    #[derive(Default)]
    struct CancelDuringExtraction {
        cancelled: AtomicBool,
        stages: std::sync::Mutex<Vec<FlashStage>>,
    }

    impl ProgressCallback for CancelDuringExtraction {
        fn on_progress(&self, progress: FlashProgress) {
            if progress.stage == FlashStage::Extracting {
                self.cancelled.store(true, Ordering::Release);
            }
            self.stages.lock().unwrap().push(progress.stage);
        }

        fn is_cancelled(&self) -> bool {
            self.cancelled.load(Ordering::Acquire)
        }
    }

    #[tokio::test]
    #[serial] // all share the mock cache directory
    async fn run_flash_writes_the_pinned_installer_without_a_release_lookup() {
        clear_mock_cache();
        for installer in &hai_core::hardware_installer::INSTALLERS {
            let backend = PinnedInstallerBackend::default();
            run_flash(
                &backend,
                &request("mock-usb-drive-128gb", installer.board).await,
                &NoOpProgress,
            )
            .await
            .unwrap();
            let image = backend.downloaded.lock().unwrap().take().unwrap();
            assert_eq!(image.download_url, installer.download_url);
            assert_eq!(image.size, installer.size);
            assert_eq!(image.digest.as_deref(), Some(installer.digest));
            assert_eq!(image.format, ImageFormat::Raw);
        }
    }

    #[tokio::test]
    #[serial] // all share the mock cache directory
    async fn run_flash_cancelled_before_writing_never_touches_the_drive() {
        clear_mock_cache();
        let callback = CancelDuringExtraction::default();

        let error = run_flash(
            &BackendMock,
            &request("mock-sd-card-32gb", "rpi5-64").await,
            &callback,
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, "cancelled");
        assert!(!callback
            .stages
            .lock()
            .unwrap()
            .contains(&FlashStage::Writing));
    }

    #[tokio::test]
    #[serial] // all share the mock cache directory
    async fn run_flash_rejects_unknown_board() {
        let err = run_flash(
            &BackendMock,
            &request("mock-sd-card-32gb", "no-such-board").await,
            &NoOpProgress,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "invalid_config");
    }

    #[tokio::test]
    #[serial] // all share the mock cache directory
    async fn run_flash_rejects_non_removable_device() {
        let err = run_flash(
            &BackendMock,
            &request("mock-nvme-500gb", "rpi5-64").await,
            &NoOpProgress,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "drive_in_system_use");
    }

    #[tokio::test]
    #[serial] // all share the mock cache directory
    async fn run_flash_rejects_swapped_device() {
        let mut request = request("mock-sd-card-32gb", "rpi5-64").await;
        request.expected_device.size = Some(64 * 1024 * 1024 * 1024);
        let err = run_flash(&BackendMock, &request, &NoOpProgress)
            .await
            .unwrap_err();
        assert!(err.message.contains("no longer the one you selected"));
    }

    #[tokio::test]
    #[serial] // all share the mock cache directory
    async fn run_utm_download_returns_extracted_image() {
        let board = hai_core::utm::HAOS_BOARD;
        let release = BackendMock
            .get_latest_haos_release_for_board(board)
            .await
            .unwrap();
        let image = release.image_for(board, ImageFormat::Qcow2).unwrap();
        assert!(image
            .download_url
            .ends_with(&format!("haos_{board}-16.3.qcow2.xz")));
        let path = run_utm_download(&BackendMock, board, &NoOpProgress)
            .await
            .unwrap();
        assert!(path.ends_with(format!("haos_{board}-16.3.qcow2")));
        assert!(path.exists());
    }

    #[tokio::test]
    #[serial]
    #[cfg(not(target_os = "macos"))]
    async fn mock_utm_download_command_works_without_native_mac_architecture() {
        use tauri::Manager;

        // Off macOS the mock command skips the Apple silicon check
        let app = tauri::test::mock_app();
        app.manage(PendingUtmImages::default());
        app.manage(InstallJobs::default());
        let path = download_utm_image(
            "attempt".into(),
            Channel::new(|_| Ok(())),
            app.state(),
            app.state(),
        )
        .await
        .unwrap();
        assert!(std::path::Path::new(&path).exists());
        assert!(path.ends_with(".qcow2"));
        assert!(app
            .state::<PendingUtmImages>()
            .0
            .lock()
            .unwrap()
            .contains(&path));
        discard_utm_image(path.clone(), app.state());
        assert!(!app
            .state::<PendingUtmImages>()
            .0
            .lock()
            .unwrap()
            .contains(&path));
        // Kept for a retry until the installer closes
        assert!(std::path::Path::new(&path).exists());
    }

    #[tokio::test]
    async fn mock_release_preserves_raw_intel_image_without_inventing_qcow2() {
        let release = BackendMock.get_haos_release("latest").await.unwrap();
        assert!(release
            .image_for("generic-x86-64", ImageFormat::Raw)
            .is_some());
        assert!(release
            .image_for("generic-x86-64", ImageFormat::Qcow2)
            .is_none());
    }
}
