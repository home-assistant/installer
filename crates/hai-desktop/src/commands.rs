//! Tauri command wrappers for hai-core functionality
//!
//! This module provides Tauri IPC commands that wrap the hai-core library.
//! It handles the bridge between Tauri's Channel<T> and hai-core's ProgressCallback trait.

use crate::backend::Backend;
use crate::command_error::CommandError;
use crate::diagnostics::Operation;
use crate::flash_state::FlashState;
use hai_core::download::TemporaryImage;
use hai_core::{
    BlockDevice, DeviceBackend, DeviceManifest, ExpectedDevice, FlashProgress, FlashRequest,
    FlashResult, FlashStage, HaosRelease, HostBackend, ImageFormat, ProgressCallback,
    ProxmoxBackend, ProxmoxBridge, ProxmoxCredentials, ProxmoxNode, ProxmoxSession, ProxmoxStorage,
    ProxmoxVmConfig, ProxmoxVmResult, ReleaseSource, SystemInfo, UtmBackend, VmStatusInfo,
};
use tauri::ipc::Channel;

#[derive(Default)]
pub struct PendingUtmImages(std::sync::Mutex<std::collections::HashMap<String, TemporaryImage>>);

impl PendingUtmImages {
    fn take(&self, image_path: &str) -> Option<TemporaryImage> {
        self.0.lock().unwrap().remove(image_path)
    }
}

// =============================================================================
// Tauri Progress Callback Adapter
// =============================================================================

/// Adapter that bridges Tauri's Channel with hai-core's ProgressCallback trait
struct TauriProgressCallback<'a> {
    channel: &'a Channel<FlashProgress>,
    operation: Operation,
}

impl<'a> TauriProgressCallback<'a> {
    fn new(channel: &'a Channel<FlashProgress>, name: &'static str) -> Self {
        Self {
            channel,
            operation: Operation::new(name),
        }
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
}

// =============================================================================
// Device Commands
// =============================================================================

/// Check internet access before starting an installation flow.
#[tauri::command]
pub async fn check_connection() -> Result<(), String> {
    Backend
        .check_connection()
        .await
        .map_err(connection_error_message)
}

fn connection_error_message(error: hai_core::Error) -> String {
    match error {
        hai_core::Error::DownloadFailed(message) => message,
        error => error.to_string(),
    }
}

/// List all block devices
#[tauri::command]
pub async fn list_block_devices() -> Result<Vec<BlockDevice>, CommandError> {
    Backend
        .list_devices()
        .await
        .map_err(CommandError::from_query)
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

    if !device.removable {
        return Err(CommandError::new(
            "invalid_config",
            format!(
                "{} is not a removable drive and cannot be overwritten",
                device_id
            ),
            false,
        ));
    }

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

    let config = hai_core::manifest::storage_requirements(board).ok_or_else(|| {
        CommandError::from(hai_core::Error::InvalidConfig(format!(
            "No storage requirements found for board: {}",
            board
        )))
    })?;
    if device.size < config.minimum_reported_storage_bytes() {
        // A board minimum, not the image size: a bigger drive is the only fix
        return Err(CommandError::new(
            "drive_too_small",
            format!(
                "The selected drive is too small. At least a {:.0} GB drive is required.",
                config.minimum_storage_bytes as f64 / 1_000_000_000.0
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
    progress_channel: Channel<FlashProgress>,
    state: tauri::State<'_, FlashState>,
) -> Result<FlashResult, CommandError> {
    state
        .run(async move {
            let callback = TauriProgressCallback::new(&progress_channel, "flash");
            callback
                .operation
                .finish(run_flash(&Backend, &request, &callback).await)
        })
        .await
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

    backend
        .check_write_privileges()
        .map_err(CommandError::from)?;

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

    // Get cache directory and download
    let cache_dir = backend.cache_dir().map_err(CommandError::from)?;
    let temporary_image =
        TemporaryImage::new(&cache_dir, ImageFormat::Raw).map_err(CommandError::from)?;
    let compressed_path = temporary_image.archive_path();

    backend
        .download_image(&image, &compressed_path, callback)
        .await
        .map_err(CommandError::from)?;

    // Extract the image
    let extracted_path = temporary_image.path();

    backend
        .extract_temporary_image(&temporary_image, callback)
        .await
        .map_err(CommandError::from)?;

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

    // Write to device
    backend
        .write_image(
            &extracted_path,
            &request.device_id,
            &request.expected_device,
            request.verify,
            callback,
        )
        .await
        .map_err(CommandError::from)?;

    drop(temporary_image);

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

/// HAOS board for UTM, from the Mac's native architecture (also under
/// Rosetta). The confirmation screen and the download must agree on it.
fn utm_board() -> Result<&'static str, CommandError> {
    #[cfg(all(feature = "mock", not(target_os = "macos")))]
    let arch = hai_core::utm::UtmArchitecture::X86_64;
    #[cfg(any(not(feature = "mock"), target_os = "macos"))]
    let arch = hai_core::utm::UtmArchitecture::host().map_err(CommandError::from)?;

    Ok(arch.haos_board())
}

/// Get the release for the same board used by UTM downloads.
#[tauri::command]
pub async fn get_utm_haos_release() -> Result<HaosRelease, CommandError> {
    release_for_selection(&Backend, None, Some(utm_board()?)).await
}

/// Download the HAOS qcow2 image for UTM
#[tauri::command]
pub async fn download_utm_image(
    progress_channel: Channel<FlashProgress>,
    pending: tauri::State<'_, PendingUtmImages>,
) -> Result<String, CommandError> {
    let callback = TauriProgressCallback::new(&progress_channel, "utm_download");

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
    let path = image.path().to_string_lossy().into_owned();
    pending.0.lock().unwrap().insert(path.clone(), image);
    Ok(path)
}

/// Download and extract the HAOS qcow2 image for `arch`, returning the extracted path.
///
/// Generic over the backend so it can be exercised against `BackendMock`.
async fn run_utm_download<B, P>(
    backend: &B,
    arch: &str,
    callback: &P,
) -> Result<TemporaryImage, CommandError>
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

    let cache_dir = backend.cache_dir().map_err(CommandError::from)?;
    let temporary_image =
        TemporaryImage::new(&cache_dir, ImageFormat::Qcow2).map_err(CommandError::from)?;
    let compressed_path = temporary_image.archive_path();

    backend
        .download_image(image, &compressed_path, callback)
        .await
        .map_err(CommandError::from)?;

    backend
        .extract_temporary_image(&temporary_image, callback)
        .await
        .map_err(CommandError::from)?;

    callback.on_progress(FlashProgress {
        stage: FlashStage::Complete,
        progress: 100,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Download complete!".to_string(),
    });

    Ok(temporary_image)
}

/// Release a downloaded image abandoned before VM creation. Unknown paths are
/// never deleted, and an image being imported has already left this registry.
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

/// Create a Home Assistant VM in UTM
#[tauri::command]
pub async fn create_utm_vm(
    config: hai_core::UtmVmConfig,
    pending: tauri::State<'_, PendingUtmImages>,
) -> Result<String, CommandError> {
    Operation::new("utm_create").finish(run_utm_creation(&Backend, &config, &pending).await)
}

async fn run_utm_creation<B: UtmBackend>(
    backend: &B,
    config: &hai_core::UtmVmConfig,
    pending: &PendingUtmImages,
) -> Result<String, CommandError> {
    let image = pending.take(&config.image_path).ok_or_else(|| {
        CommandError::new(
            "temporary_image_unavailable",
            "Temporary image is no longer available; download it again",
            true,
        )
    })?;
    image.begin_utm_import().map_err(|error| {
        CommandError::new(
            "utm",
            format!(
                "Could not prepare the UTM import: {error}. UTM was not contacted. \
         Any retained source directory at {} can be removed manually.",
                image.path().parent().unwrap().display()
            ),
            false,
        )
    })?;
    // Fully qualified: `create_vm` is defined on both UtmBackend and ProxmoxBackend.
    let result = UtmBackend::create_vm(backend, config, &hai_core::NoOpProgress).await;
    if let Err(hai_core::Error::UtmOperationUncertain(error)) = &result {
        return Err(CommandError::new(
            "utm_operation_uncertain",
            format!(
                "UTM may still be importing the image: {error}. Source retained at {}. \
             Check UTM before retrying. Remove the source directory manually only after \
             confirming UTM has finished or stopped importing.",
                image.path().parent().unwrap().display()
            ),
            false,
        ));
    }
    // A completed creation or confirmed rejection no longer needs the source.
    if image.finish_utm_import().is_err() {
        crate::diagnostics::warning("utm_source_cleanup_failed");
    }
    result.map(|result| result.id).map_err(CommandError::from)
}

/// Start a UTM VM
#[tauri::command(async)]
pub fn start_utm_vm(vm_id: String) -> Result<(), CommandError> {
    Operation::new("utm_start").finish(Backend.start_vm(&vm_id).map_err(CommandError::from))
}

/// Resize a UTM VM's disk
#[tauri::command]
pub fn resize_utm_vm_disk(vm_id: String, size_gb: u32) -> Result<(), CommandError> {
    Operation::new("utm_resize").finish(
        Backend
            .resize_vm_disk(&vm_id, size_gb)
            .map_err(CommandError::from),
    )
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

/// Create a Home Assistant VM on Proxmox
#[tauri::command]
pub async fn proxmox_create_vm(
    session: ProxmoxSession,
    config: ProxmoxVmConfig,
    progress_channel: Channel<FlashProgress>,
) -> Result<ProxmoxVmResult, CommandError> {
    let callback = TauriProgressCallback::new(&progress_channel, "proxmox_install");
    // Fully qualified: `create_vm` is defined on both ProxmoxBackend and UtmBackend.
    callback.operation.finish(
        ProxmoxBackend::create_vm(&Backend, &session, &config, &callback)
            .await
            .map_err(|error| {
                let mut error = CommandError::from(error);
                // A lost response may leave a VM behind. This command cannot yet
                // resume it safely, even when the underlying network error is transient.
                error.retryable = false;
                error
            }),
    )
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
        assert!(proxmox_list_nodes(session)
            .await
            .unwrap_err()
            .message
            .contains("HTTPS"));
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
        let channel = Channel::new(|_| {
            let tail = crate::diagnostics::test_log_tail();
            assert!(!tail
                .iter()
                .any(|line| line.contains("rust utm_download") && line.contains(" success ")));
            Ok(())
        });
        let path = download_utm_image(channel, app.state()).await.unwrap();
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
        let channel = Channel::new(|_| panic!("An unsupported UTM download must not start"));
        let error = download_utm_image(channel, app.state()).await.unwrap_err();
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

    #[test]
    fn connection_error_message_unwraps_download_errors() {
        let message =
            "Cannot reach version.home-assistant.io. Check your internet connection and try again.";
        let error = hai_core::Error::DownloadFailed(message.to_string());
        assert_eq!(connection_error_message(error), message);
    }

    #[test]
    fn connection_error_message_preserves_other_errors() {
        assert_eq!(
            connection_error_message(hai_core::Error::Cancelled),
            "Operation cancelled"
        );
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
            assert!(!device.haos.download_url.is_empty());
            // Verify URL template contains placeholder
            assert!(device.haos.download_url.contains("{version}"));
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

    #[test]
    #[cfg(target_os = "macos")]
    fn test_resize_utm_vm_disk_non_mock_returns_ok() {
        let result = resize_utm_vm_disk("test-vm".to_string(), 64);
        // Should return Ok even though not implemented
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

    #[cfg(not(feature = "mock"))] // asserts on the real backend's answers
    #[test]
    #[cfg(not(target_os = "macos"))]
    fn test_resize_utm_vm_disk_unsupported_off_macos() {
        let err = resize_utm_vm_disk("test-vm".to_string(), 64).unwrap_err();
        assert_eq!(err.code, "unsupported_platform");
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

    #[cfg(not(feature = "mock"))] // asserts on the real backend's answers
    #[tokio::test]
    async fn test_check_ha_ready_empty_ip() {
        let result = check_ha_ready("".to_string()).await;
        assert!(!result, "Should return false for empty IP");
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
        assert!(err.message.contains("not a removable drive"), "{err}");
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
            _: &std::path::Path,
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
            panic!("must not report progress before privilege preflight succeeds");
        }
    }

    #[tokio::test]
    async fn privilege_failures_abort_before_progress_or_release_lookup() {
        fn not_elevated() -> hai_core::Result<()> {
            Err(hai_core::Error::PermissionDenied(
                "Run as administrator".into(),
            ))
        }
        fn query_failed() -> hai_core::Result<()> {
            Err(hai_core::Error::Io(std::io::Error::other(
                "token query failed",
            )))
        }
        async fn attempt(
            check: fn() -> hai_core::Result<()>,
            callback: &impl ProgressCallback,
        ) -> Result<FlashResult, CommandError> {
            let request = FlashRequest {
                device_id: "unused-device".into(),
                board: "rpi5-64".into(),
                verify: true,
                expected_device: ExpectedDevice::default(),
            };
            run_flash(&PreflightBackend { check }, &request, callback).await
        }

        for check in [not_elevated, query_failed] {
            let err = attempt(check, &NoProgressExpected).await.unwrap_err();
            assert_eq!(err, CommandError::from(check().unwrap_err()));
        }

        // An authorized attempt reaches release lookup without real network I/O.
        let retry = attempt(|| Ok(()), &hai_core::NoOpProgress)
            .await
            .unwrap_err();
        assert!(retry.message.contains("release lookup reached"), "{retry}");
    }
}

#[cfg(all(test, feature = "mock"))]
mod mock_tests {
    use super::*;
    use hai_core::{BackendMock, NoOpProgress};
    use serial_test::serial;

    struct LifecycleBackend {
        cache: tempfile::TempDir,
        outcome: &'static str,
        extracted: std::sync::Mutex<Option<std::path::PathBuf>>,
        write_started: tokio::sync::Notify,
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
            BackendMock.get_latest_haos_release_for_board(board).await
        }
        async fn download_image<P: ProgressCallback>(
            &self,
            _: &hai_core::HaosImage,
            dest: &std::path::Path,
            _: &P,
        ) -> hai_core::Result<()> {
            std::fs::write(dest, b"archive")?;
            Ok(())
        }
        async fn extract_xz<P: ProgressCallback>(
            &self,
            _: &std::path::Path,
            dest: &std::path::Path,
            _: &P,
        ) -> hai_core::Result<()> {
            *self.extracted.lock().unwrap() = Some(dest.to_path_buf());
            std::fs::write(dest, b"image")?;
            if self.outcome == "extract" {
                return Err(hai_core::Error::ExtractionFailed(
                    "test extraction failure".into(),
                ));
            }
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
            path: &std::path::Path,
            _: &str,
            _: &hai_core::ExpectedDevice,
            _: bool,
            _: &P,
        ) -> hai_core::Result<()> {
            assert_ne!(
                self.outcome, "oversized",
                "oversized image reached disk writer"
            );
            assert_eq!(std::fs::read(path).unwrap(), b"image");
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
    async fn flash_releases_extraction_on_every_exit() {
        for outcome in [
            "success",
            "extract",
            "write",
            "cancel",
            "suspend",
            "oversized",
        ] {
            let backend = LifecycleBackend {
                cache: tempfile::tempdir().unwrap(),
                outcome,
                extracted: Default::default(),
                write_started: Default::default(),
            };
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
            assert!(!path.exists(), "{outcome}");
            assert!(!path.parent().unwrap().exists(), "{outcome}");
            assert_eq!(std::fs::read_dir(backend.cache.path()).unwrap().count(), 0);
        }
    }

    #[tokio::test]
    async fn utm_download_keeps_images_private_until_owner_releases_them() {
        for outcome in ["success", "extract"] {
            let backend = LifecycleBackend {
                cache: tempfile::tempdir().unwrap(),
                outcome,
                extracted: Default::default(),
                write_started: Default::default(),
            };
            let result = run_utm_download(&backend, "generic-aarch64", &NoOpProgress).await;
            assert_eq!(result.is_ok(), outcome == "success");
            if let Ok(image) = &result {
                assert!(image.path().exists());
                assert!(image.archive_path().exists());
            }
            drop(result);
            let path = backend.extracted.lock().unwrap().clone().unwrap();
            assert!(!path.exists());
            assert_eq!(std::fs::read_dir(backend.cache.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn utm_registry_never_deletes_unknown_or_in_use_images() {
        let cache = tempfile::tempdir().unwrap();
        let user_file = cache.path().join("user.qcow2");
        std::fs::write(&user_file, b"user image").unwrap();
        let pending = PendingUtmImages::default();
        assert!(pending.take(user_file.to_str().unwrap()).is_none());
        assert!(user_file.exists());
        let image = TemporaryImage::new(cache.path(), ImageFormat::Qcow2).unwrap();
        let path = image.path().to_string_lossy().into_owned();
        std::fs::write(&path, b"owned image").unwrap();
        pending.0.lock().unwrap().insert(path.clone(), image);
        let importing = pending.take(&path).unwrap();
        assert!(pending.take(&path).is_none());
        assert!(std::path::Path::new(&path).exists());
        drop(importing);
        assert!(!std::path::Path::new(&path).exists());
        assert!(user_file.exists());
    }

    struct UtmCreationBackend {
        outcome: &'static str,
        started: tokio::sync::Notify,
    }

    impl UtmBackend for UtmCreationBackend {
        async fn check_utm_status(&self) -> hai_core::Result<hai_core::UtmStatus> {
            unreachable!()
        }

        async fn create_vm<P: ProgressCallback>(
            &self,
            config: &hai_core::UtmVmConfig,
            _: &P,
        ) -> hai_core::Result<hai_core::UtmVmResult> {
            let source = std::path::Path::new(&config.image_path);
            assert!(source.exists());
            assert!(source.parent().unwrap().join(".utm-import").exists());
            self.started.notify_one();
            match self.outcome {
                "release-failure" => {
                    let marker = source.parent().unwrap().join(".utm-import");
                    std::fs::remove_file(&marker).unwrap();
                    std::fs::create_dir(marker).unwrap();
                    Ok(hai_core::UtmVmResult {
                        id: "stable-utm-id".into(),
                        name: config.name.clone(),
                        path: None,
                    })
                }
                "success" => Ok(hai_core::UtmVmResult {
                    id: "stable-utm-id".into(),
                    name: config.name.clone(),
                    path: None,
                }),
                "rejected" => Err(hai_core::Error::Utm("Invalid configuration".into())),
                "start-failed" => Err(hai_core::Error::UtmVmCreated(
                    "The VM was created. Open UTM to start it.".into(),
                )),
                "timeout" => Err(hai_core::Error::UtmOperationUncertain(
                    "AppleEvent timed out (-1712)".into(),
                )),
                "transport" => Err(hai_core::Error::UtmOperationUncertain(
                    "Failed to wait for AppleScript".into(),
                )),
                "cancelled" => std::future::pending().await,
                _ => unreachable!(),
            }
        }

        fn start_vm(&self, _: &str) -> hai_core::Result<()> {
            unreachable!()
        }
        fn resize_vm_disk(&self, _: &str, _: u32) -> hai_core::Result<()> {
            unreachable!()
        }
        fn vm_status(&self, _: &str) -> hai_core::Result<VmStatusInfo> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn utm_source_cleanup_requires_a_confirmed_outcome() {
        for outcome in [
            "success",
            "rejected",
            "start-failed",
            "timeout",
            "transport",
            "cancelled",
            "marker-failure",
            "release-failure",
        ] {
            let cache = tempfile::tempdir().unwrap();
            let image = TemporaryImage::new(cache.path(), ImageFormat::Qcow2).unwrap();
            let path = image.path();
            std::fs::write(&path, b"source image").unwrap();
            if outcome == "marker-failure" {
                std::fs::create_dir(path.parent().unwrap().join(".utm-import")).unwrap();
            }
            let pending = PendingUtmImages::default();
            pending
                .0
                .lock()
                .unwrap()
                .insert(path.to_string_lossy().into_owned(), image);
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
                assert!(pending.take(&config.image_path).is_none());
                assert!(path.exists());
            } else {
                let result = run_utm_creation(&backend, &config, &pending).await;
                assert_eq!(
                    result.is_ok(),
                    matches!(outcome, "success" | "release-failure"),
                    "{outcome}"
                );
                if let Ok(id) = &result {
                    assert_eq!(id, "stable-utm-id");
                    assert_ne!(id, &config.name);
                }
                if matches!(outcome, "timeout" | "transport") {
                    let error = result.as_ref().unwrap_err();
                    assert!(error.message.contains(&format!(
                        "Source retained at {}.",
                        path.parent().unwrap().display()
                    )));
                    assert!(!error.message.contains(&config.image_path));
                    assert!(error.message.contains("manually"));
                }
                if outcome == "start-failed" {
                    let error = result.as_ref().unwrap_err();
                    assert_eq!(error.code, "utm_vm_created");
                    assert!(!error.retryable);
                    assert!(error.message.contains("Open UTM"));
                }
                if outcome == "marker-failure" {
                    let error = result.unwrap_err();
                    assert!(error.message.contains("UTM was not contacted"));
                    assert!(error
                        .message
                        .contains(path.parent().unwrap().to_str().unwrap()));
                    assert!(error.message.contains("manually"));
                }
            }
            // This is the same removal used by the frontend's discard command.
            assert!(pending.take(&config.image_path).is_none());
            drop(pending);
            hai_core::download::prune_cached_images(cache.path()).unwrap();
            assert_eq!(
                path.exists(),
                !matches!(outcome, "success" | "rejected" | "start-failed"),
                "{outcome}"
            );
        }
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
            _: &std::path::Path,
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
            path: &std::path::Path,
            device_id: &str,
            expected: &hai_core::ExpectedDevice,
            verify: bool,
            callback: &P,
        ) -> hai_core::Result<()> {
            BackendMock
                .write_image(path, device_id, expected, verify, callback)
                .await
        }
    }

    #[tokio::test]
    #[serial] // all share the mock cache directory
    async fn run_flash_writes_the_pinned_installer_without_a_release_lookup() {
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
        assert!(err.message.contains("not a removable drive"));
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
        use hai_core::utm::UtmArchitecture;

        for arch in [UtmArchitecture::Aarch64, UtmArchitecture::X86_64] {
            let release = BackendMock
                .get_latest_haos_release_for_board(arch.haos_board())
                .await
                .unwrap();
            let image = release
                .image_for(arch.haos_board(), ImageFormat::Qcow2)
                .unwrap();
            assert!(image
                .download_url
                .ends_with(&format!("haos_{}-16.3.qcow2.xz", arch.haos_board())));
            let image = run_utm_download(&BackendMock, arch.haos_board(), &NoOpProgress)
                .await
                .unwrap();
            let path = image.path();
            assert!(path.exists());
            drop(image);
            assert!(!path.exists());
        }
    }

    #[tokio::test]
    #[serial]
    #[cfg(not(target_os = "macos"))]
    async fn mock_utm_download_command_works_without_native_mac_architecture() {
        use tauri::Manager;

        // Off macOS the mock command uses the Intel OVA board without Rosetta
        // detection; run_utm_download_returns_extracted_image covers that board.
        let app = tauri::test::mock_app();
        app.manage(PendingUtmImages::default());
        let path = download_utm_image(Channel::new(|_| Ok(())), app.state())
            .await
            .unwrap();
        assert!(std::path::Path::new(&path).exists());
        assert!(path.ends_with(".qcow2"));
        assert!(app
            .state::<PendingUtmImages>()
            .0
            .lock()
            .unwrap()
            .contains_key(&path));
        discard_utm_image(path.clone(), app.state());
        assert!(!std::path::Path::new(&path).exists());
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
