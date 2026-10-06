//! Tauri command wrappers for hai-core functionality
//!
//! This module provides Tauri IPC commands that wrap the hai-core library.
//! It handles the bridge between Tauri's Channel<T> and hai-core's ProgressCallback trait.

use hai_core::{
    disk, download, is_mock_enabled, mock, BlockDevice, DeviceManifest, ExpectedDevice,
    FlashProgress, FlashRequest, FlashStage, HaosRelease, ImageFormat, ProgressCallback,
    ProxmoxCredentials, ProxmoxNode, ProxmoxSession, ProxmoxStorage, ProxmoxVmConfig,
    ProxmoxVmResult, SystemInfo, UpdateInfo, VmStatusInfo,
};
use std::time::Duration;
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
#[derive(serde::Serialize)]
pub struct FlashResult {
    pub success: bool,
    pub error: Option<String>,
    pub duration_secs: u64,
}

// =============================================================================
// Mock Mode Commands
// =============================================================================

/// Check if mock mode is enabled
#[tauri::command]
pub fn is_mock_mode() -> bool {
    is_mock_enabled()
}

// =============================================================================
// Device Commands
// =============================================================================

/// List all block devices
#[tauri::command]
pub async fn list_block_devices() -> Result<Vec<BlockDevice>, String> {
    if is_mock_enabled() {
        Ok(mock::get_mock_block_devices())
    } else {
        disk::list_devices().await.map_err(|e| e.to_string())
    }
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
    if is_mock_enabled() {
        simulate_flash_progress(&progress_channel).await;
        return Ok(FlashResult {
            success: true,
            error: None,
            duration_secs: 45,
        });
    }

    let start_time = std::time::Instant::now();
    let callback = TauriProgressCallback::new(&progress_channel);

    // Send initial progress
    callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Fetching release info...".to_string(),
    });

    // Fetch the latest HAOS release
    let release = download::get_haos_release("latest")
        .await
        .map_err(|e| format!("Failed to fetch release info: {}", e))?;

    // Find the raw disk image for the requested board. Some boards also ship a
    // qcow2 under the same board name, which must never be written to a drive.
    let image = download::find_image_for_board(&release, &request.board, ImageFormat::Raw)
        .ok_or_else(|| format!("No image found for board: {}", request.board))?;

    callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 0,
        bytes_processed: 0,
        total_bytes: image.size,
        message: "Starting download...".to_string(),
    });

    // Get cache directory and download
    let cache_dir = download::get_cache_dir().map_err(|e| format!("Cache error: {}", e))?;
    let image_filename = format!("haos_{}.img.xz", request.board);
    let compressed_path = cache_dir.join(&image_filename);

    download::download_image(&image.download_url, &compressed_path, &callback)
        .await
        .map_err(|e| e.to_string())?;

    // Extract the image
    let extracted_filename = image_filename.replace(".xz", "");
    let extracted_path = cache_dir.join(&extracted_filename);

    download::extract_xz(&compressed_path, &extracted_path, &callback)
        .await
        .map_err(|e| e.to_string())?;

    // Check image size vs device size
    let image_size = tokio::fs::metadata(&extracted_path)
        .await
        .map_err(|e| format!("Failed to get image size: {}", e))?
        .len();

    let device_list = disk::list_devices()
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
    disk::write_image(
        &extracted_path,
        &request.device_id,
        request.verify,
        &callback,
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

/// Simulate flash progress for mock mode
async fn simulate_flash_progress(channel: &Channel<FlashProgress>) {
    let total_bytes: u64 = 2 * 1024 * 1024 * 1024;
    let stages: [(FlashStage, &str, u32); 4] = [
        (FlashStage::Downloading, "Downloading image...", 40),
        (FlashStage::Verifying, "Verifying download...", 10),
        (FlashStage::Writing, "Writing to device...", 45),
        (FlashStage::Finalizing, "Finalizing...", 5),
    ];

    let mut overall_progress: u32 = 0;

    for (stage, message, stage_weight) in stages {
        let steps: u32 = 10;
        for step in 0..=steps {
            let stage_progress = step * 100 / steps;
            let bytes_for_stage = (total_bytes as f64
                * (stage_weight as f64 / 100.0)
                * (step as f64 / steps as f64)) as u64;

            let current_progress = overall_progress + (stage_progress * stage_weight / 100);

            let _ = channel.send(FlashProgress {
                stage: stage.clone(),
                progress: current_progress.min(100) as u8,
                bytes_processed: bytes_for_stage
                    + (total_bytes as f64 * (overall_progress as f64 / 100.0)) as u64,
                total_bytes,
                message: message.to_string(),
            });

            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        overall_progress += stage_weight;
    }

    let _ = channel.send(FlashProgress {
        stage: FlashStage::Complete,
        progress: 100,
        bytes_processed: total_bytes,
        total_bytes,
        message: "Installation complete!".to_string(),
    });
}

// =============================================================================
// Release/Manifest Commands
// =============================================================================

/// Get the latest HAOS release information
#[tauri::command]
pub async fn get_haos_release(version: Option<String>) -> Result<HaosRelease, String> {
    if is_mock_enabled() {
        return Ok(mock::get_mock_haos_release());
    }

    let ver = version.as_deref().unwrap_or("latest");
    download::get_haos_release(ver)
        .await
        .map_err(|e| e.to_string())
}

/// Check for application updates
#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    download::check_for_updates()
        .await
        .map_err(|e| e.to_string())
}

/// Get the device manifest
#[tauri::command]
pub async fn get_manifest() -> Result<DeviceManifest, String> {
    download::get_device_manifest()
        .await
        .map_err(|e| e.to_string())
}

// =============================================================================
// System Info Commands
// =============================================================================

/// Get system information (CPU cores and memory) for VM configuration limits
#[tauri::command]
pub fn get_system_info() -> Result<SystemInfo, String> {
    if is_mock_enabled() {
        return Ok(SystemInfo {
            cpu_cores: 10,
            memory_mb: 32768,
        });
    }

    hai_core::host::system_info().map_err(|e| e.to_string())
}

// =============================================================================
// UTM Commands (macOS only)
// =============================================================================

/// Download the HAOS qcow2 image for UTM
#[tauri::command]
#[cfg(target_os = "macos")]
pub async fn download_utm_image(
    progress_channel: Channel<FlashProgress>,
) -> Result<String, String> {
    use hai_core::utm;

    if is_mock_enabled() {
        simulate_utm_download_progress(&progress_channel).await;
        let mock_path = "/tmp/mock-haos.qcow2";
        // Create minimal valid qcow2 header
        let qcow2_header: [u8; 512] = {
            let mut header = [0u8; 512];
            header[0..4].copy_from_slice(&[0x51, 0x46, 0x49, 0xfb]);
            header[4..8].copy_from_slice(&[0x00, 0x00, 0x00, 0x03]);
            header[20..24].copy_from_slice(&[0x00, 0x00, 0x00, 0x10]);
            header[24..32].copy_from_slice(&[0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00]);
            header
        };
        std::fs::write(mock_path, qcow2_header)
            .map_err(|e| format!("Failed to create mock qcow2: {}", e))?;
        return Ok(mock_path.to_string());
    }

    let callback = TauriProgressCallback::new(&progress_channel);

    // Get architecture (also verifies UTM is available)
    let _status = utm::check_utm_status().await.map_err(|e| e.to_string())?;
    let arch = if cfg!(target_arch = "aarch64") {
        "generic-aarch64"
    } else {
        "generic-x86-64"
    };

    callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Fetching release info...".to_string(),
    });

    let release = download::get_haos_release("latest")
        .await
        .map_err(|e| format!("Failed to fetch release: {}", e))?;

    let image = download::find_image_for_board(&release, arch, ImageFormat::Qcow2)
        .ok_or_else(|| format!("No qcow2 image found for: {}", arch))?;

    let cache_dir = download::get_cache_dir().map_err(|e| e.to_string())?;
    let compressed_path = cache_dir.join(format!("haos_{}.qcow2.xz", arch));

    download::download_image(&image.download_url, &compressed_path, &callback)
        .await
        .map_err(|e| e.to_string())?;

    let extracted_path = cache_dir.join(format!("haos_{}.qcow2", arch));
    download::extract_xz(&compressed_path, &extracted_path, &callback)
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

#[cfg(target_os = "macos")]
async fn simulate_utm_download_progress(channel: &Channel<FlashProgress>) {
    let stages: [(FlashStage, &str, u32); 2] = [
        (FlashStage::Downloading, "Downloading HAOS image...", 70),
        (FlashStage::Extracting, "Extracting image...", 30),
    ];

    let mut overall_progress: u32 = 0;

    for (stage, message, stage_weight) in stages {
        let steps: u32 = 10;
        for step in 0..=steps {
            let stage_progress = step * 100 / steps;
            let current_progress = overall_progress + (stage_progress * stage_weight / 100);

            let _ = channel.send(FlashProgress {
                stage: stage.clone(),
                progress: current_progress.min(100) as u8,
                bytes_processed: 0,
                total_bytes: 0,
                message: message.to_string(),
            });

            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        overall_progress += stage_weight;
    }

    let _ = channel.send(FlashProgress {
        stage: FlashStage::Complete,
        progress: 100,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Download complete!".to_string(),
    });
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
pub async fn download_utm_image(
    _progress_channel: Channel<FlashProgress>,
) -> Result<String, String> {
    Err("UTM is only available on macOS".to_string())
}

/// Check if UTM is installed and get its status
#[tauri::command]
#[cfg(target_os = "macos")]
pub async fn check_utm_status() -> Result<hai_core::UtmStatus, String> {
    hai_core::utm::check_utm_status()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
pub fn check_utm_status() -> serde_json::Value {
    serde_json::json!({
        "installed": false,
        "path": null,
        "version": null
    })
}

/// Create a Home Assistant VM in UTM
#[tauri::command]
#[cfg(target_os = "macos")]
pub async fn create_utm_vm(config: hai_core::UtmVmConfig) -> Result<String, String> {
    if is_mock_enabled() {
        return Ok("mock-vm-id-12345".to_string());
    }

    let result = hai_core::utm::create_vm(&config, &hai_core::NoOpProgress)
        .await
        .map_err(|e| e.to_string())?;

    Ok(result.name)
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
pub fn create_utm_vm(_config: serde_json::Value) -> Result<String, String> {
    Err("UTM is only available on macOS".to_string())
}

/// Start a UTM VM
#[tauri::command]
#[cfg(target_os = "macos")]
pub fn start_utm_vm(_vm_id: String) -> Result<(), String> {
    if is_mock_enabled() {
        return Ok(());
    }
    // TODO: Implement via AppleScript
    Ok(())
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
pub fn start_utm_vm(_vm_id: String) -> Result<(), String> {
    Err("UTM is only available on macOS".to_string())
}

/// Resize a UTM VM's disk
#[tauri::command]
#[cfg(target_os = "macos")]
pub fn resize_utm_vm_disk(_vm_id: String, _size_gb: u32) -> Result<(), String> {
    if is_mock_enabled() {
        return Ok(());
    }
    // TODO: Implement via qemu-img
    Ok(())
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
pub fn resize_utm_vm_disk(_vm_id: String, _size_gb: u32) -> Result<(), String> {
    Err("UTM is only available on macOS".to_string())
}

/// Get the status of a UTM VM
#[tauri::command]
#[cfg(target_os = "macos")]
pub fn get_utm_vm_status(vm_id: String) -> Result<VmStatusInfo, String> {
    if is_mock_enabled() {
        return Ok(VmStatusInfo {
            status: "started".to_string(),
            ip_address: Some("192.168.1.100".to_string()),
        });
    }
    hai_core::utm::vm_status(&vm_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
pub fn get_utm_vm_status(_vm_id: String) -> Result<VmStatusInfo, String> {
    Err("UTM is only available on macOS".to_string())
}

// =============================================================================
// HA Status Commands
// =============================================================================

/// Check if Home Assistant webserver is ready
#[tauri::command]
pub async fn check_ha_ready(ip_address: String) -> bool {
    if is_mock_enabled() {
        return true;
    }

    hai_core::host::check_ha_ready(&ip_address).await
}

/// Check if Home Assistant has finished updating
#[tauri::command]
pub async fn check_ha_updated(ip_address: String) -> bool {
    if is_mock_enabled() {
        return true;
    }

    hai_core::host::check_ha_updated(&ip_address).await
}

// =============================================================================
// Proxmox Commands
// =============================================================================

/// Connect to a Proxmox VE server
#[tauri::command]
pub async fn proxmox_connect(credentials: ProxmoxCredentials) -> Result<ProxmoxSession, String> {
    if is_mock_enabled() {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        return Ok(ProxmoxSession {
            server_url: credentials.server_url,
            ticket: format!(
                "mock-ticket-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            ),
            csrf_token: format!(
                "mock-csrf-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            ),
        });
    }

    hai_core::proxmox::authenticate(&credentials)
        .await
        .map_err(|e| e.to_string())
}

/// List available nodes on Proxmox
#[tauri::command]
pub async fn proxmox_list_nodes(session: ProxmoxSession) -> Result<Vec<ProxmoxNode>, String> {
    if is_mock_enabled() {
        tokio::time::sleep(Duration::from_millis(500)).await;
        return Ok(vec![
            ProxmoxNode {
                name: "pve".to_string(),
                status: "online".to_string(),
                cpu_usage: Some(12.5),
                memory_used: Some(8 * 1024 * 1024 * 1024),
                memory_total: Some(32 * 1024 * 1024 * 1024),
            },
            ProxmoxNode {
                name: "pve2".to_string(),
                status: "online".to_string(),
                cpu_usage: Some(8.2),
                memory_used: Some(4 * 1024 * 1024 * 1024),
                memory_total: Some(16 * 1024 * 1024 * 1024),
            },
        ]);
    }

    hai_core::proxmox::list_nodes(&session)
        .await
        .map_err(|e| e.to_string())
}

/// List available storage on a Proxmox node
#[tauri::command]
pub async fn proxmox_list_storage(
    session: ProxmoxSession,
    node: String,
) -> Result<Vec<ProxmoxStorage>, String> {
    if is_mock_enabled() {
        tokio::time::sleep(Duration::from_millis(500)).await;
        return Ok(vec![
            ProxmoxStorage {
                name: "local".to_string(),
                storage_type: "dir".to_string(),
                content: vec![
                    "images".to_string(),
                    "rootdir".to_string(),
                    "vztmpl".to_string(),
                    "backup".to_string(),
                    "iso".to_string(),
                    "snippets".to_string(),
                ],
                available: 200 * 1024 * 1024 * 1024,
                total: 500 * 1024 * 1024 * 1024,
                active: true,
            },
            ProxmoxStorage {
                name: "local-lvm".to_string(),
                storage_type: "lvmthin".to_string(),
                content: vec!["images".to_string(), "rootdir".to_string()],
                available: 400 * 1024 * 1024 * 1024,
                total: 1024 * 1024 * 1024 * 1024,
                active: true,
            },
        ]);
    }

    hai_core::proxmox::list_storage(&session, &node)
        .await
        .map_err(|e| e.to_string())
}

/// Get the next available VM ID on Proxmox
#[tauri::command]
pub async fn proxmox_get_next_vm_id(session: ProxmoxSession) -> Result<u32, String> {
    if is_mock_enabled() {
        tokio::time::sleep(Duration::from_millis(200)).await;
        return Ok(100);
    }

    hai_core::proxmox::get_next_vm_id(&session)
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
    if is_mock_enabled() {
        simulate_proxmox_install_progress(&progress_channel).await;
        return Ok(ProxmoxVmResult {
            vm_id: config.vm_id,
            node: config.node,
            ip_address: Some("192.168.1.150".to_string()),
        });
    }

    let callback = TauriProgressCallback::new(&progress_channel);
    hai_core::proxmox::create_vm(&session, &config, &callback)
        .await
        .map_err(|e| e.to_string())
}

async fn simulate_proxmox_install_progress(channel: &Channel<FlashProgress>) {
    let stages: [(FlashStage, &str, u32); 5] = [
        (FlashStage::Downloading, "Downloading HAOS image...", 40),
        (FlashStage::Extracting, "Uploading to Proxmox...", 25),
        (FlashStage::Writing, "Creating virtual machine...", 20),
        (FlashStage::Verifying, "Starting Home Assistant...", 10),
        (FlashStage::Finalizing, "Waiting for network...", 5),
    ];

    let mut overall_progress: u32 = 0;

    for (stage, message, stage_weight) in stages {
        let steps: u32 = 10;
        for step in 0..=steps {
            let stage_progress = step * 100 / steps;
            let current_progress = overall_progress + (stage_progress * stage_weight / 100);

            let _ = channel.send(FlashProgress {
                stage: stage.clone(),
                progress: current_progress.min(100) as u8,
                bytes_processed: 0,
                total_bytes: 0,
                message: message.to_string(),
            });

            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        overall_progress += stage_weight;
    }

    let _ = channel.send(FlashProgress {
        stage: FlashStage::Complete,
        progress: 100,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Installation complete!".to_string(),
    });
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    // ===== Mock Mode Tests =====

    #[test]
    #[serial]
    fn test_is_mock_mode_returns_correct_value() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        assert!(is_mock_mode());
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[test]
    #[serial]
    fn test_is_mock_mode_returns_false_when_disabled() {
        std::env::remove_var("HA_INSTALLER_MOCK");
        assert!(!is_mock_mode());
    }

    #[test]
    #[serial]
    fn test_is_mock_mode_returns_true_for_true_string() {
        std::env::set_var("HA_INSTALLER_MOCK", "true");
        assert!(is_mock_mode());
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[test]
    #[serial]
    fn test_is_mock_mode_returns_false_for_invalid_value() {
        std::env::set_var("HA_INSTALLER_MOCK", "0");
        assert!(!is_mock_mode());
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

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

    // ===== UTM Command Tests - macOS Specific =====

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn test_create_utm_vm_non_macos() {
        let result = create_utm_vm(serde_json::json!({
            "name": "Test VM",
            "memory_mb": 4096,
            "cpu_cores": 2,
            "disk_size_gb": 32,
            "image_path": "/tmp/test.qcow2"
        }));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("macOS"));
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn test_start_utm_vm_non_macos() {
        let result = start_utm_vm("test-vm-id".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("macOS"));
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn test_resize_utm_vm_disk_non_macos() {
        let result = resize_utm_vm_disk("test-vm-id".to_string(), 64);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("macOS"));
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn test_get_utm_vm_status_non_macos() {
        let result = get_utm_vm_status("test-vm-id".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("macOS"));
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn test_check_utm_status_non_macos() {
        let result = check_utm_status();
        // Should return a JSON value with installed: false
        assert_eq!(result["installed"], false);
        assert_eq!(result["path"], serde_json::Value::Null);
        assert_eq!(result["version"], serde_json::Value::Null);
    }

    // ===== Non-mock System Info Tests =====

    #[test]
    #[serial]
    #[cfg(target_os = "macos")]
    fn test_system_info_macos_fallback_on_error() {
        std::env::remove_var("HA_INSTALLER_MOCK");
        let info = get_system_info().unwrap();
        // Should return valid values even if sysctl fails (fallback to defaults)
        assert!(info.cpu_cores >= 4);
        assert!(info.memory_mb >= 8192);
    }

    #[test]
    #[serial]
    #[cfg(not(target_os = "macos"))]
    fn test_system_info_non_macos() {
        std::env::remove_var("HA_INSTALLER_MOCK");
        assert!(get_system_info().is_err());
    }

    // ===== Additional edge case tests =====

    #[test]
    #[serial]
    #[cfg(target_os = "macos")]
    fn test_start_utm_vm_non_mock_returns_ok() {
        std::env::remove_var("HA_INSTALLER_MOCK");
        let result = start_utm_vm("test-vm".to_string());
        // Should return Ok even though not implemented
        assert!(result.is_ok());
    }

    #[test]
    #[serial]
    #[cfg(target_os = "macos")]
    fn test_resize_utm_vm_disk_non_mock_returns_ok() {
        std::env::remove_var("HA_INSTALLER_MOCK");
        let result = resize_utm_vm_disk("test-vm".to_string(), 64);
        // Should return Ok even though not implemented
        assert!(result.is_ok());
    }

    #[test]
    #[serial]
    #[cfg(target_os = "macos")]
    fn test_get_utm_vm_status_non_mock_returns_unknown() {
        std::env::remove_var("HA_INSTALLER_MOCK");
        let result = get_utm_vm_status("test-vm".to_string());
        assert!(result.is_ok());
        let status = result.unwrap();
        assert_eq!(status.status, "unknown");
        assert_eq!(status.ip_address, None);
    }

    // ===== check_ha_ready() Tests =====

    #[tokio::test]
    #[serial]
    async fn test_check_ha_ready_empty_ip() {
        std::env::remove_var("HA_INSTALLER_MOCK");
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
