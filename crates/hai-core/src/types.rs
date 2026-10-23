//! Type definitions for hai-core
//!
//! This module contains all the shared types used across the Home Assistant
//! Installer, including block device representations, flash progress,
//! and configuration types.

use serde::{Deserialize, Serialize};

#[cfg(test)]
mod bindings;

/// Represents a block device (SD card, USB drive, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct BlockDevice {
    /// Unique identifier (e.g., "/dev/sda" on Linux, "disk2" on macOS)
    pub id: String,
    /// Human-readable name
    pub name: String,
    /// Size in bytes
    pub size: u64,
    /// Device type
    pub device_type: DeviceType,
    /// Whether this is a removable device
    pub removable: bool,
    /// Model name if available
    pub model: Option<String>,
    /// Vendor name if available
    pub vendor: Option<String>,
    /// Hardware serial, when reported by the device (not a filesystem UUID).
    pub serial: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum DeviceType {
    SdCard,
    UsbDrive,
    Ssd,
    Hdd,
    Nvme,
    Unknown,
}

/// Progress event sent during flashing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FlashProgress {
    /// Current stage of the process
    pub stage: FlashStage,
    /// Progress percentage (0-100)
    pub progress: u8,
    /// Bytes processed so far
    pub bytes_processed: u64,
    /// Total bytes to process
    pub total_bytes: u64,
    /// Human-readable message
    pub message: String,
}

impl FlashProgress {
    /// Build a progress event, deriving the percentage from the byte counts.
    pub fn new(stage: FlashStage, bytes_processed: u64, total_bytes: u64, message: &str) -> Self {
        let progress = if total_bytes > 0 {
            ((u128::from(bytes_processed.min(total_bytes)) * 100) / u128::from(total_bytes)) as u8
        } else {
            0
        };
        Self {
            stage,
            progress,
            bytes_processed,
            total_bytes,
            message: message.to_string(),
        }
    }
}

/// Assert that `updates` go through `stages` in order, the way the progress
/// views expect from any backend: stages that move bytes count them from 0 to
/// 100%, the others report once at 0%.
#[cfg(test)]
pub(crate) fn assert_progress_shape(updates: &[FlashProgress], stages: &[FlashStage]) {
    let runs: Vec<_> = updates.chunk_by(|a, b| a.stage == b.stage).collect();
    let seen: Vec<_> = runs.iter().map(|run| run[0].stage.clone()).collect();
    assert_eq!(seen, stages);
    for run in runs {
        let (first, last) = (&run[0], &run[run.len() - 1]);
        match first.stage {
            FlashStage::Complete => assert!(run.iter().all(|u| u.progress == 100), "{run:?}"),
            FlashStage::Finalizing | FlashStage::CreatingVm | FlashStage::StartingVm => {
                assert_eq!(run.len(), 1, "{run:?}");
                assert_eq!(
                    (first.progress, first.bytes_processed, first.total_bytes),
                    (0, 0, 0)
                );
            }
            _ => {
                assert!(
                    run.windows(2)
                        .all(|pair| pair[0].progress <= pair[1].progress
                            && pair[0].bytes_processed <= pair[1].bytes_processed),
                    "{run:?}"
                );
                assert_eq!(first.progress, 0, "{run:?}");
                assert_ne!(last.total_bytes, 0, "{run:?}");
                assert_eq!(
                    (last.progress, last.bytes_processed),
                    (100, last.total_bytes)
                );
                assert!(run.iter().all(|u| u.bytes_processed <= u.total_bytes));
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum FlashStage {
    Downloading,
    Extracting,
    /// Writing the image to a disk
    Writing,
    /// Verifying the image written to a disk
    Verifying,
    /// Flushing a written disk before it is removed
    Finalizing,
    /// Uploading the image to a hypervisor's storage
    Uploading,
    /// Creating a VM from the uploaded image
    CreatingVm,
    /// Starting a newly created VM
    StartingVm,
    Complete,
    Error,
}

/// Device manifest for supported devices
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct DeviceManifest {
    /// Version of the manifest format
    pub version: u32,
    /// List of supported devices
    pub devices: Vec<Device>,
}

/// A supported device in the manifest
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Device {
    /// Unique device identifier
    pub id: String,
    /// Human-readable name
    pub name: String,
    /// Device category
    pub category: DeviceCategory,
    /// Image URL for the device photo
    pub image_url: Option<String>,
    /// HAOS image configuration
    pub haos: HaosConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum DeviceCategory {
    RaspberryPi,
    Odroid,
    Khadas,
    Asus,
    HomeAssistantHardware,
    GenericX86,
    GenericArm64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct HaosConfig {
    /// Board identifier for the HAOS image
    pub board: String,
    /// Minimum nominal target capacity in decimal bytes, with 5% reserved-space allowance.
    pub minimum_storage_bytes: u64,
    /// Recommended nominal target capacity in decimal bytes, with the same allowance.
    pub recommended_storage_bytes: u64,
}

impl HaosConfig {
    /// Actual reported capacity needed for the nominal minimum. Keep the 5%
    /// allowance in sync with reportedCapacityFloor in the frontend.
    pub fn minimum_reported_storage_bytes(&self) -> u64 {
        self.minimum_storage_bytes - self.minimum_storage_bytes / 20
    }
}

/// Flash request parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FlashRequest {
    /// Target device ID (block device path)
    pub device_id: String,
    /// Board identifier (e.g., "rpi5-64", "green")
    pub board: String,
    /// Whether to verify after writing
    pub verify: bool,
    /// What the device at `device_id` looked like when the user selected it
    pub expected_device: ExpectedDevice,
    /// Network for Home Assistant OS to join on first boot
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub wifi: Option<WifiConfig>,
}

/// A WPA2 network, written to the drive and never stored by the installer.
#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct WifiConfig {
    pub ssid: String,
    pub password: String,
}

// The password must not end up in a log through `{:?}`
impl std::fmt::Debug for WifiConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WifiConfig")
            .field("ssid", &self.ssid)
            .finish_non_exhaustive()
    }
}

/// Identity of the selected drive, re-checked right before writing.
///
/// `device_id` is a path the OS can reassign to another device, for example
/// while the image downloads. `None` means the field was unknown.
/// Request-only: serde accepts both omitted fields and explicit nulls.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct ExpectedDevice {
    pub size: Option<u64>,
    pub model: Option<String>,
    pub vendor: Option<String>,
    pub serial: Option<String>,
}

impl ExpectedDevice {
    /// Whether `device` still looks like the selected drive. Every device
    /// reports a size, so an unknown expected size never matches.
    /// A serial is required only when it was known at selection time.
    pub fn matches(&self, device: &BlockDevice) -> bool {
        self.size == Some(device.size)
            && self.model == device.model
            && self.vendor == device.vendor
            && (self.serial.is_none() || self.serial == device.serial)
    }
}

/// HAOS release information from GitHub
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct HaosRelease {
    /// Version string (e.g., "16.3")
    pub version: String,
    /// List of available images
    pub images: Vec<HaosImage>,
}

impl HaosRelease {
    /// The image for `board` in `format`, if the release ships one.
    pub fn image_for(&self, board: &str, format: ImageFormat) -> Option<&HaosImage> {
        self.images
            .iter()
            .find(|img| img.board == board && img.format == format)
    }
}

/// Disk format of a HAOS image
///
/// A release can ship several formats for the same board (e.g. generic-aarch64
/// has both `.img.xz` and `.qcow2.xz`), so lookups must pick the format explicitly.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum ImageFormat {
    /// Raw disk image (`.img.xz`), written byte-for-byte to a drive
    #[default]
    Raw,
    /// QEMU disk image (`.qcow2.xz`), used for virtual machines
    Qcow2,
}

/// A single HAOS image file
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct HaosImage {
    /// Board name (e.g., "rpi5-64", "green", "generic-x86-64")
    pub board: String,
    /// Disk format of the image
    #[serde(default)]
    pub format: ImageFormat,
    /// Download URL
    pub download_url: String,
    /// File size in bytes
    pub size: u64,
    /// Verified SHA-256 of the compressed asset. Required for installation.
    #[serde(default)]
    pub digest: Option<String>,
}

/// GitHub release asset from API
#[derive(Debug, Clone, Deserialize)]
pub struct GitHubAsset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
}

/// GitHub release from API
#[derive(Debug, Clone, Deserialize)]
pub struct GitHubRelease {
    pub tag_name: String,
    pub assets: Vec<GitHubAsset>,
}

/// Result of a flash operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FlashResult {
    /// Duration in seconds
    pub duration_secs: u64,
}

/// Stable version info from version.home-assistant.io/stable.json
#[derive(Debug, Clone, Deserialize)]
pub struct StableVersionInfo {
    /// HAOS versions per board
    pub hassos: std::collections::HashMap<String, String>,
}

// ============================================================================
// Proxmox VE Types
// ============================================================================

/// Proxmox connection credentials
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ProxmoxCredentials {
    /// Proxmox server URL (e.g., https://192.168.1.100:8006)
    pub server_url: String,
    /// Username (e.g., root@pam)
    pub username: String,
    /// Password
    pub password: String,
    /// Optional time-based one-time password from an authenticator app.
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub totp: Option<String>,
    /// Explicitly confirmed SHA-256 leaf certificate fingerprint, for this login only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate_sha256: Option<String>,
}

/// Proxmox session (authentication result)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ProxmoxSession {
    /// Server URL for the session
    pub server_url: String,
    /// Authentication ticket
    pub ticket: String,
    /// CSRF prevention token
    pub csrf_token: String,
    /// Certificate approved at login; enforce it for every request in this session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate_sha256: Option<String>,
}

/// Proxmox node information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ProxmoxNode {
    /// Node name
    pub name: String,
    /// Node status (online/offline)
    pub status: String,
    /// CPU usage as Proxmox reports it, a fraction from 0 to 1 (0.15 is 15%)
    pub cpu_usage: Option<f64>,
    /// Logical CPUs; Proxmox won't start a VM with more cores than this
    pub cpu_count: Option<u32>,
}

/// Proxmox storage information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ProxmoxStorage {
    /// Storage name
    pub name: String,
    /// Storage type (local, nfs, cifs, etc.)
    pub storage_type: String,
    /// Content types (images, rootdir, iso, etc.)
    pub content: Vec<String>,
    /// Available space in bytes
    pub available: u64,
    /// Whether storage is active
    pub active: bool,
}

/// A node-local Linux bridge, Open vSwitch bridge, or SDN VNet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ProxmoxBridge {
    pub name: String,
    pub network_type: String,
    /// Whether the reported bridge configuration supports guest VLAN tags.
    #[serde(default)]
    pub vlan_aware: bool,
    pub comments: Option<String>,
}

/// Configuration for creating a Proxmox VM
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ProxmoxVmConfig {
    /// Target node name
    pub node: String,
    /// Target storage name
    pub storage: String,
    /// Network bridge or SDN VNet selected on the target node
    pub bridge: String,
    /// Optional guest VLAN tag (1..=4094); absent keeps the network untagged.
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub vlan_tag: Option<u16>,
    /// VM ID (e.g., 100)
    pub vm_id: u32,
    /// VM name
    pub name: String,
    /// Number of CPU cores
    pub cpu_cores: u32,
    /// Memory in MB
    pub memory_mb: u32,
    /// Disk size in GB
    pub disk_size_gb: u32,
}

/// Proxmox VM creation result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ProxmoxVmResult {
    /// The created VM ID
    pub vm_id: u32,
    /// Node where VM was created
    pub node: String,
}

// ============================================================================
// UTM Types (macOS)
// ============================================================================

/// Configuration for creating a UTM virtual machine
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UtmVmConfig {
    /// VM name
    pub name: String,
    /// Path to the HAOS qcow2 image file
    pub image_path: String,
    /// Number of CPU cores
    pub cpu_cores: u32,
    /// Memory in MB
    pub memory_mb: u32,
    /// Disk size in GB
    pub disk_size_gb: u32,
    /// Whether to start VM after creation
    pub auto_start: bool,
}

/// UTM VM creation result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UtmVmResult {
    /// UTM's unique identifier, used for subsequent status and start commands
    pub id: String,
    /// The created VM name
    pub name: String,
    /// Path to the VM bundle
    pub path: Option<String>,
}

/// UTM application status
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UtmStatus {
    /// Whether UTM is installed
    pub installed: bool,
    /// UTM version if installed
    pub version: Option<String>,
    /// Path to UTM application
    pub path: Option<String>,
}

// ============================================================================
// Host / VM status types
// ============================================================================

/// Host system information (CPU cores and memory)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct SystemInfo {
    /// Number of logical CPU cores.
    pub cpu_cores: usize,
    /// Total memory in megabytes.
    pub memory_mb: u64,
}

/// Status of a provisioned VM
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct VmStatusInfo {
    /// VM run status (e.g. "started", "unknown").
    pub status: String,
    /// The VM's IP address, if known.
    pub ip_address: Option<String>,
}

/// What Supervisor reports, through the Home Assistant OS landing page, while
/// it installs Home Assistant Core
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct HaSetupStatus {
    /// Progress (0-100) of the Core download, while Supervisor runs it.
    pub core_install_progress: Option<f64>,
    /// Progress (0-100) of Supervisor updating itself, which on a first boot
    /// usually comes before the Core download.
    pub supervisor_update_progress: Option<f64>,
    /// Problems that can hold up the install, most fundamental first.
    pub problems: Vec<HaSetupProblem>,
}

/// A problem Supervisor reports that can keep Home Assistant Core from installing
///
/// Declared most fundamental first: without internet, every download fails.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum HaSetupProblem {
    /// The host or Supervisor cannot reach the internet.
    NoInternet,
    /// The data disk is (almost) full.
    FreeSpace,
    /// The container registry limits the pulls.
    DockerRatelimit,
    /// Downloading an update of Supervisor or Core failed.
    UpdateFailed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_expected_device_serial_fallback() {
        let device = BlockDevice {
            id: "/dev/sdb".into(),
            name: "USB Drive".into(),
            size: 32_000_000_000,
            device_type: DeviceType::UsbDrive,
            removable: true,
            model: Some("Ultra Fit".into()),
            vendor: Some("SanDisk".into()),
            serial: Some("STICK-A".into()),
        };
        let expected = ExpectedDevice {
            size: Some(device.size),
            model: device.model.clone(),
            vendor: device.vendor.clone(),
            serial: None,
        };
        assert!(expected.matches(&device));
        assert!(expected.matches(&BlockDevice {
            serial: None,
            ..device.clone()
        }));
        for changed in [
            BlockDevice {
                size: 1,
                ..device.clone()
            },
            BlockDevice {
                model: None,
                ..device.clone()
            },
            BlockDevice {
                vendor: None,
                ..device.clone()
            },
        ] {
            assert!(!expected.matches(&changed));
        }
        let known = ExpectedDevice {
            serial: device.serial.clone(),
            ..expected
        };
        assert!(known.matches(&device));
        for serial in [None, Some("STICK-B".into())] {
            assert!(!known.matches(&BlockDevice {
                serial,
                ..device.clone()
            }));
        }
    }

    #[test]
    fn progress_shape_accepts_a_flash_ending_in_two_completes() {
        // The writer's `complete` carries the image size, `run_flash`'s none
        let size = 4096;
        let updates = [
            FlashProgress::new(FlashStage::Writing, 0, size, "Writing"),
            FlashProgress::new(FlashStage::Writing, size, size, "Written"),
            FlashProgress::new(FlashStage::Finalizing, 0, 0, "Ejecting"),
            FlashProgress::new(FlashStage::Complete, size, size, "Complete"),
            FlashProgress {
                progress: 100,
                ..FlashProgress::new(FlashStage::Complete, 0, 0, "Installation complete!")
            },
        ];
        assert_progress_shape(
            &updates,
            &[
                FlashStage::Writing,
                FlashStage::Finalizing,
                FlashStage::Complete,
            ],
        );
    }

    #[test]
    fn test_haos_image_missing_format_defaults_to_raw() {
        let json = r#"{"board":"green","download_url":"u","size":1}"#;
        let parsed: HaosImage = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.format, ImageFormat::Raw);
    }

    #[test]
    fn test_image_for() {
        use ImageFormat::{Qcow2, Raw};

        let image = |board: &str, format, download_url: &str| HaosImage {
            board: board.to_string(),
            format,
            download_url: download_url.to_string(),
            digest: None,
            size: 100,
        };
        // generic-aarch64 ships both a raw image and a qcow2 under the same board name.
        // Put the qcow2 first so a board-only lookup would pick the wrong one.
        let release = HaosRelease {
            version: "14.2".to_string(),
            images: vec![
                image("rpi5-64", Raw, "rpi5.img.xz"),
                image("green", Raw, "green.img.xz"),
                image("generic-aarch64", Qcow2, "aarch64.qcow2.xz"),
                image("generic-aarch64", Raw, "aarch64.img.xz"),
            ],
        };

        for (board, format, expected) in [
            ("green", Raw, Some("green.img.xz")),
            ("generic-aarch64", Raw, Some("aarch64.img.xz")),
            ("generic-aarch64", Qcow2, Some("aarch64.qcow2.xz")),
            ("rpi5-64", Qcow2, None),
            ("nonexistent", Raw, None),
        ] {
            let found = release.image_for(board, format);
            assert_eq!(
                found.map(|image| image.download_url.as_str()),
                expected,
                "{board} {format:?}"
            );
        }
    }
}
