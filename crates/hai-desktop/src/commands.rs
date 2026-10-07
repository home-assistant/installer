//! Tauri command wrappers for hai-core functionality
//!
//! This module provides Tauri IPC commands that wrap the hai-core library.
//! It handles the bridge between Tauri's Channel<T> and hai-core's ProgressCallback trait.

use crate::backend::Backend;
use hai_core::{
    BlockDevice, DeviceBackend, DeviceManifest, ExpectedDevice, FlashProgress, FlashRequest,
    FlashStage, HaosRelease, HostBackend, ImageFormat, ProgressCallback, ProxmoxBackend,
    ProxmoxCredentials, ProxmoxNode, ProxmoxSession, ProxmoxStorage, ProxmoxVmConfig,
    ProxmoxVmResult, ReleaseSource, SystemInfo, UpdateInfo, UtmBackend, VmStatusInfo,
};
use tauri::ipc::Channel;

// =============================================================================
// Tauri Progress Callback Adapter
// =============================================================================

/// Adapter that bridges Tauri's Channel with hai-core's ProgressCallback trait
struct TauriProgressCallback<'a> {
    channel: &'a Channel<FlashProgress>,
}

impl<'a> TauriProgressCallback<'a> {
    fn new(channel: &'a Channel<FlashProgress>) -> Self {
        Self { channel }
    }
}

impl<'a> ProgressCallback for TauriProgressCallback<'a> {
    fn on_progress(&self, progress: FlashProgress) {
        let _ = self.channel.send(progress);
    }
}

// =============================================================================
// Request/Response Types
// =============================================================================

/// Result of a flash operation
#[derive(Debug, serde::Serialize)]
pub struct FlashResult {
    pub success: bool,
    pub error: Option<String>,
    pub duration_secs: u64,
}

// =============================================================================
// Device Commands
// =============================================================================

/// List all block devices
#[tauri::command]
pub async fn list_block_devices() -> Result<Vec<BlockDevice>, String> {
    Backend.list_devices().await.map_err(|e| e.to_string())
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
) -> Result<&'a BlockDevice, String> {
    let device = devices.iter().find(|d| d.id == device_id).ok_or_else(|| {
        format!(
            "Device {} not found. It may have been disconnected.",
            device_id
        )
    })?;

    if !device.removable {
        return Err(format!(
            "{} is not a removable drive and cannot be overwritten",
            device_id
        ));
    }

    if !expected.matches(device) {
        return Err(format!(
            "The drive at {} is no longer the one you selected. It may have been \
             swapped for another device; please select your drive again.",
            device_id
        ));
    }

    Ok(device)
}

/// Flash an image to a device
#[tauri::command]
pub async fn flash_image(
    request: FlashRequest,
    progress_channel: Channel<FlashProgress>,
) -> Result<FlashResult, String> {
    let callback = TauriProgressCallback::new(&progress_channel);
    run_flash(&Backend, &request, &callback).await
}

/// Download, extract, and write the image for `request`.
///
/// Generic over the backend so the whole flow can be exercised against
/// `BackendMock`.
async fn run_flash<B, P>(
    backend: &B,
    request: &FlashRequest,
    callback: &P,
) -> Result<FlashResult, String>
where
    B: ReleaseSource + DeviceBackend,
    P: ProgressCallback,
{
    let start_time = std::time::Instant::now();

    // Send initial progress
    callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Fetching release info...".to_string(),
    });

    // Fetch the latest HAOS release
    let release = backend
        .get_haos_release("latest")
        .await
        .map_err(|e| format!("Failed to fetch release info: {}", e))?;

    // Find the raw disk image for the requested board. Some boards also ship a
    // qcow2 under the same board name, which must never be written to a drive.
    let image = release
        .image_for(&request.board, ImageFormat::Raw)
        .ok_or_else(|| format!("No image found for board: {}", request.board))?;

    callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 0,
        bytes_processed: 0,
        total_bytes: image.size,
        message: "Starting download...".to_string(),
    });

    // Get cache directory and download
    let cache_dir = backend
        .cache_dir()
        .map_err(|e| format!("Cache error: {}", e))?;
    let image_filename = format!("haos_{}.img.xz", request.board);
    let compressed_path = cache_dir.join(&image_filename);

    backend
        .download_image(&image.download_url, &compressed_path, callback)
        .await
        .map_err(|e| e.to_string())?;

    // Extract the image
    let extracted_filename = image_filename.replace(".xz", "");
    let extracted_path = cache_dir.join(&extracted_filename);

    backend
        .extract_xz(&compressed_path, &extracted_path, callback)
        .await
        .map_err(|e| e.to_string())?;

    // Check image size vs device size
    let image_size = tokio::fs::metadata(&extracted_path)
        .await
        .map_err(|e| format!("Failed to get image size: {}", e))?
        .len();

    let device_list = backend
        .list_devices()
        .await
        .map_err(|e| format!("Failed to list devices: {}", e))?;

    let device = find_flash_target(&device_list, &request.device_id, &request.expected_device)?;

    if image_size > device.size {
        return Err(format!(
            "Image is too large for the selected device. Image size: {:.1} GB, Device size: {:.1} GB.",
            image_size as f64 / 1_000_000_000.0,
            device.size as f64 / 1_000_000_000.0
        ));
    }

    // Write to device
    backend
        .write_image(
            &extracted_path,
            &request.device_id,
            request.verify,
            callback,
        )
        .await
        .map_err(|e| match e {
            // Verify-phase failures are tagged VerificationFailed; the rest are writes.
            hai_core::Error::VerificationFailed(msg) => format!("Verification failed: {}", msg),
            // Already carries its own "Disk service unavailable:" prefix.
            err @ hai_core::Error::DiskServiceUnavailable(_) => err.to_string(),
            // A disconnect doesn't require a prefix
            err @ hai_core::Error::DriveDisconnected => err.to_string(),
            // Self-explanatory messages; a "Write failed:" prefix would bury them.
            err @ hai_core::Error::ImageTooLarge { .. } => err.to_string(),
            err @ hai_core::Error::Cancelled => err.to_string(),
            hai_core::Error::PermissionDenied(msg) => msg,
            other => format!("Write failed: {}", other),
        })?;

    // Clean up extracted image
    let _ = tokio::fs::remove_file(&extracted_path).await;

    let duration = start_time.elapsed();

    callback.on_progress(FlashProgress {
        stage: FlashStage::Complete,
        progress: 100,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Installation complete!".to_string(),
    });

    Ok(FlashResult {
        success: true,
        error: None,
        duration_secs: duration.as_secs(),
    })
}

// =============================================================================
// Release/Manifest Commands
// =============================================================================

/// Get the latest HAOS release information
#[tauri::command]
pub async fn get_haos_release(version: Option<String>) -> Result<HaosRelease, String> {
    let ver = version.as_deref().unwrap_or("latest");
    Backend
        .get_haos_release(ver)
        .await
        .map_err(|e| e.to_string())
}

/// Check for application updates
#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    Backend.check_for_updates().await.map_err(|e| e.to_string())
}

/// Get the device manifest
#[tauri::command]
pub async fn get_manifest() -> Result<DeviceManifest, String> {
    Backend
        .get_device_manifest()
        .await
        .map_err(|e| e.to_string())
}

// =============================================================================
// System Info Commands
// =============================================================================

/// Get system information (CPU cores and memory) for VM configuration limits
#[tauri::command]
pub fn get_system_info() -> Result<SystemInfo, String> {
    Backend.system_info().map_err(|e| e.to_string())
}

// =============================================================================
// UTM Commands (macOS only)
// =============================================================================

/// Download the HAOS qcow2 image for UTM
#[tauri::command]
pub async fn download_utm_image(
    progress_channel: Channel<FlashProgress>,
) -> Result<String, String> {
    let callback = TauriProgressCallback::new(&progress_channel);

    // Verify UTM is available before doing any work.
    Backend
        .check_utm_status()
        .await
        .map_err(|e| e.to_string())?;
    let arch = if cfg!(target_arch = "aarch64") {
        "generic-aarch64"
    } else {
        "generic-x86-64"
    };

    run_utm_download(&Backend, arch, &callback).await
}

/// Download and extract the HAOS qcow2 image for `arch`, returning the extracted path.
///
/// Generic over the backend so it can be exercised against `BackendMock`.
async fn run_utm_download<B, P>(backend: &B, arch: &str, callback: &P) -> Result<String, String>
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
        .get_haos_release("latest")
        .await
        .map_err(|e| format!("Failed to fetch release: {}", e))?;

    let image = release
        .image_for(arch, ImageFormat::Qcow2)
        .ok_or_else(|| format!("No qcow2 image found for: {}", arch))?;

    let cache_dir = backend.cache_dir().map_err(|e| e.to_string())?;
    let compressed_path = cache_dir.join(format!("haos_{}.qcow2.xz", arch));

    backend
        .download_image(&image.download_url, &compressed_path, callback)
        .await
        .map_err(|e| e.to_string())?;

    let extracted_path = cache_dir.join(format!("haos_{}.qcow2", arch));
    backend
        .extract_xz(&compressed_path, &extracted_path, callback)
        .await
        .map_err(|e| e.to_string())?;

    callback.on_progress(FlashProgress {
        stage: FlashStage::Complete,
        progress: 100,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Download complete!".to_string(),
    });

    Ok(extracted_path.to_string_lossy().to_string())
}

/// Check if UTM is installed and get its status
#[tauri::command]
pub async fn check_utm_status() -> Result<hai_core::UtmStatus, String> {
    Backend.check_utm_status().await.map_err(|e| e.to_string())
}

/// Create a Home Assistant VM in UTM
#[tauri::command]
pub async fn create_utm_vm(config: hai_core::UtmVmConfig) -> Result<String, String> {
    // Fully qualified: `create_vm` is defined on both UtmBackend and ProxmoxBackend.
    let result = UtmBackend::create_vm(&Backend, &config, &hai_core::NoOpProgress)
        .await
        .map_err(|e| e.to_string())?;

    Ok(result.name)
}

/// Start a UTM VM
#[tauri::command]
pub fn start_utm_vm(vm_id: String) -> Result<(), String> {
    Backend.start_vm(&vm_id).map_err(|e| e.to_string())
}

/// Resize a UTM VM's disk
#[tauri::command]
pub fn resize_utm_vm_disk(vm_id: String, size_gb: u32) -> Result<(), String> {
    Backend
        .resize_vm_disk(&vm_id, size_gb)
        .map_err(|e| e.to_string())
}

/// Get the status of a UTM VM
#[tauri::command]
pub fn get_utm_vm_status(vm_id: String) -> Result<VmStatusInfo, String> {
    Backend.vm_status(&vm_id).map_err(|e| e.to_string())
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

/// Connect to a Proxmox VE server
#[tauri::command]
pub async fn proxmox_connect(credentials: ProxmoxCredentials) -> Result<ProxmoxSession, String> {
    Backend
        .authenticate(&credentials)
        .await
        .map_err(|e| e.to_string())
}

/// List available nodes on Proxmox
#[tauri::command]
pub async fn proxmox_list_nodes(session: ProxmoxSession) -> Result<Vec<ProxmoxNode>, String> {
    Backend
        .list_nodes(&session)
        .await
        .map_err(|e| e.to_string())
}

/// List available storage on a Proxmox node
#[tauri::command]
pub async fn proxmox_list_storage(
    session: ProxmoxSession,
    node: String,
) -> Result<Vec<ProxmoxStorage>, String> {
    Backend
        .list_storage(&session, &node)
        .await
        .map_err(|e| e.to_string())
}

/// Get the next available VM ID on Proxmox
#[tauri::command]
pub async fn proxmox_get_next_vm_id(session: ProxmoxSession) -> Result<u32, String> {
    Backend
        .get_next_vm_id(&session)
        .await
        .map_err(|e| e.to_string())
}

/// Create a Home Assistant VM on Proxmox
#[tauri::command]
pub async fn proxmox_create_vm(
    session: ProxmoxSession,
    config: ProxmoxVmConfig,
    progress_channel: Channel<FlashProgress>,
) -> Result<ProxmoxVmResult, String> {
    let callback = TauriProgressCallback::new(&progress_channel);
    // Fully qualified: `create_vm` is defined on both ProxmoxBackend and UtmBackend.
    ProxmoxBackend::create_vm(&Backend, &session, &config, &callback)
        .await
        .map_err(|e| e.to_string())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ===== Update Info Tests =====

    #[tokio::test]
    async fn test_check_for_updates_returns_ok() {
        let result = check_for_updates().await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_check_for_updates_has_valid_structure() {
        let result = check_for_updates().await;
        assert!(result.is_ok());
        let update_info = result.unwrap();
        assert!(!update_info.current_version.is_empty());
        assert!(!update_info.latest_version.is_empty());
    }

    // ===== Manifest Tests =====

    #[tokio::test]
    async fn test_get_manifest_returns_ok() {
        let result = get_manifest().await;
        assert!(result.is_ok());
        let manifest = result.unwrap();
        assert!(!manifest.devices.is_empty());
    }

    #[tokio::test]
    async fn test_get_manifest_has_devices() {
        let result = get_manifest().await;
        assert!(result.is_ok());
        let manifest = result.unwrap();
        assert!(!manifest.devices.is_empty());
        assert!(manifest.version > 0);
    }

    #[tokio::test]
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
        // Should return valid values even if sysctl fails (fallback to defaults)
        assert!(info.cpu_cores >= 4);
        assert!(info.memory_mb >= 8192);
    }

    #[cfg(not(feature = "mock"))] // asserts on the real backend's answers
    #[test]
    #[cfg(not(target_os = "macos"))]
    fn test_system_info_non_macos() {
        assert!(get_system_info().is_err());
    }

    // ===== Additional edge case tests =====

    #[test]
    #[cfg(target_os = "macos")]
    fn test_start_utm_vm_non_mock_returns_ok() {
        let result = start_utm_vm("test-vm".to_string());
        // Should return Ok even though not implemented
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
        assert!(err.contains("only available on macOS"), "{err}");
    }

    #[cfg(not(feature = "mock"))] // asserts on the real backend's answers
    #[test]
    #[cfg(not(target_os = "macos"))]
    fn test_resize_utm_vm_disk_unsupported_off_macos() {
        let err = resize_utm_vm_disk("test-vm".to_string(), 64).unwrap_err();
        assert!(err.contains("only available on macOS"), "{err}");
    }

    #[cfg(not(feature = "mock"))] // asserts on the real backend's answers
    #[test]
    #[cfg(target_os = "macos")]
    fn test_get_utm_vm_status_non_mock_returns_unknown() {
        let result = get_utm_vm_status("test-vm".to_string());
        assert!(result.is_ok());
        let status = result.unwrap();
        assert_eq!(status.status, "unknown");
        assert_eq!(status.ip_address, None);
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
        let device = find_flash_target(&devices, "/dev/sdb", &expected()).unwrap();
        assert_eq!(device.id, "/dev/sdb");
    }

    #[test]
    fn test_find_flash_target_rejects_unknown_device() {
        let devices = [flash_target("/dev/sdb", true)];
        let err = find_flash_target(&devices, "/dev/sdz", &expected()).unwrap_err();
        assert!(err.contains("not found"), "{err}");
    }

    #[test]
    fn test_find_flash_target_rejects_non_removable_device() {
        let devices = [flash_target("\\\\.\\PhysicalDrive1", false)];
        let err = find_flash_target(&devices, "\\\\.\\PhysicalDrive1", &expected()).unwrap_err();
        assert!(err.contains("not a removable drive"), "{err}");
    }

    #[test]
    fn test_find_flash_target_rejects_empty_device_id() {
        let devices = [flash_target("/dev/sdb", true)];
        let err = find_flash_target(&devices, "", &expected()).unwrap_err();
        assert!(err.contains("not found"), "{err}");
    }

    #[test]
    fn test_find_flash_target_rejects_different_device_at_same_path() {
        let mut device = flash_target("/dev/sdb", true);
        device.model = Some("Extreme".to_string());
        let err = find_flash_target(&[device], "/dev/sdb", &expected()).unwrap_err();
        assert!(err.contains("no longer the one you selected"), "{err}");
    }

    #[test]
    fn test_find_flash_target_rejects_unknown_expected_size() {
        let devices = [flash_target("/dev/sdb", true)];
        let unknown = ExpectedDevice::default();
        assert!(find_flash_target(&devices, "/dev/sdb", &unknown).is_err());
    }
}

#[cfg(all(test, feature = "mock"))]
mod mock_tests {
    use super::*;
    use hai_core::{BackendMock, NoOpProgress};
    use serial_test::serial;

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
            },
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
        assert!(result.success);
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
        assert!(err.contains("No image found"));
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
        assert!(err.contains("not a removable drive"));
    }

    #[tokio::test]
    #[serial] // all share the mock cache directory
    async fn run_flash_rejects_swapped_device() {
        let mut request = request("mock-sd-card-32gb", "rpi5-64").await;
        request.expected_device.size = Some(64 * 1024 * 1024 * 1024);
        let err = run_flash(&BackendMock, &request, &NoOpProgress)
            .await
            .unwrap_err();
        assert!(err.contains("no longer the one you selected"));
    }

    #[tokio::test]
    #[serial] // all share the mock cache directory
    async fn run_utm_download_returns_extracted_image() {
        let path = run_utm_download(&BackendMock, "generic-aarch64", &NoOpProgress)
            .await
            .unwrap();
        assert!(std::path::Path::new(&path).exists());
    }
}
