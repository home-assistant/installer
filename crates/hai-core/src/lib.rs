//! hai-core - Core library for Home Assistant Installer
//!
//! This library provides the shared business logic for the Home Assistant
//! Installer, including device enumeration, image downloading, disk writing,
//! and VM provisioning for Proxmox and UTM.
//!
//! The library is designed to be frontend-agnostic, supporting both the
//! Tauri desktop application and potential TUI implementations.

// The backend traits use `async fn`. They are only ever used through the
// concrete `Backend`/`BackendMock` types (static dispatch, never `dyn`), so the
// returned futures' `Send`-ness is inferred at each call site. The missing
// `Send` bound the lint warns about therefore cannot bite us.
#![allow(async_fn_in_trait)]

pub mod disk;
pub mod download;
pub mod error;
pub mod host;
pub mod manifest;
pub mod types;

#[cfg(feature = "mock")]
pub mod mock;

#[cfg(feature = "proxmox")]
pub mod proxmox;

#[cfg(feature = "utm")]
pub mod utm;

pub use error::{Error, Result};
#[cfg(feature = "mock")]
pub use mock::BackendMock;
pub use types::*;

use std::path::{Path, PathBuf};

// ===========================================================================
// Backend traits
// ===========================================================================
//
// One trait per backend concern. They describe the surface the application
// uses from hai-core, so that a frontend can be wired to `BackendMock` instead
// of `Backend` without touching the domain modules.

/// Release metadata and image download.
pub trait ReleaseSource {
    /// Check that the Home Assistant version service can be reached.
    async fn check_connection(&self) -> Result<()>;

    /// Fetch the device manifest (list of supported boards).
    async fn get_device_manifest(&self) -> Result<DeviceManifest>;

    /// Fetch a HAOS release by version, or the latest when `version == "latest"`.
    async fn get_haos_release(&self, version: &str) -> Result<HaosRelease>;

    /// Fetch the release stable.json currently lists for `board`.
    async fn get_latest_haos_release_for_board(&self, board: &str) -> Result<HaosRelease>;

    /// Download an image to `dest_path`, verifying its trusted compressed-asset digest.
    async fn download_image<P: ProgressCallback>(
        &self,
        image: &HaosImage,
        dest_path: &Path,
        progress_callback: &P,
    ) -> Result<()>;

    /// Extract a `.xz` archive to `dest_path`, reporting progress.
    async fn extract_xz<P: ProgressCallback>(
        &self,
        archive_path: &Path,
        dest_path: &Path,
        progress_callback: &P,
    ) -> Result<()>;

    /// Extract into an owned temporary image. Background workers must retain a
    /// clone until they stop using the directory, even if the caller is cancelled.
    async fn extract_temporary_image<P: ProgressCallback>(
        &self,
        image: &download::TemporaryImage,
        progress_callback: &P,
    ) -> Result<()> {
        self.extract_xz(&image.archive_path(), &image.path(), progress_callback)
            .await
    }

    /// Directory where downloaded images are cached.
    fn cache_dir(&self) -> Result<PathBuf>;
}

/// Block-device enumeration and raw image writing.
///
/// On Linux, enumeration excludes read-only disks and disks backing system
/// mounts, active swap, or active storage. The writer repeats these checks before
/// unmounting and opening the device. Callers must still validate the target's
/// identity and enforce their removability policy across platforms.
pub trait DeviceBackend {
    /// Check process privileges before preparing an image, without opening a drive.
    /// Defaults to success for backends that authorize access during `write_image`.
    fn check_write_privileges(&self) -> Result<()> {
        Ok(())
    }

    /// List block devices, subject to platform-specific filtering.
    async fn list_devices(&self) -> Result<Vec<BlockDevice>>;

    /// Write an image to the device with this id, reporting progress.
    ///
    /// Platform safety checks do not replace caller validation of device
    /// identity and removability.
    async fn write_image<P: ProgressCallback>(
        &self,
        image_path: &Path,
        device_id: &str,
        verify: bool,
        progress_callback: &P,
    ) -> Result<()>;
}

/// Proxmox VE provisioning.
pub trait ProxmoxBackend {
    /// Authenticate and verify the server meets the minimum version.
    async fn authenticate(&self, credentials: &ProxmoxCredentials) -> Result<ProxmoxSession>;

    /// List cluster nodes.
    async fn list_nodes(&self, session: &ProxmoxSession) -> Result<Vec<ProxmoxNode>>;

    /// List storage available on a node.
    async fn list_storage(
        &self,
        session: &ProxmoxSession,
        node: &str,
    ) -> Result<Vec<ProxmoxStorage>>;

    /// Get the next free VM id.
    async fn get_next_vm_id(&self, session: &ProxmoxSession) -> Result<u32>;

    /// Create a Home Assistant VM, reporting progress.
    async fn create_vm<P: ProgressCallback>(
        &self,
        session: &ProxmoxSession,
        config: &ProxmoxVmConfig,
        progress_callback: &P,
    ) -> Result<ProxmoxVmResult>;
}

/// UTM provisioning (macOS).
pub trait UtmBackend {
    /// Check whether UTM is installed and report its status.
    async fn check_utm_status(&self) -> Result<UtmStatus>;

    /// Create a Home Assistant VM in UTM, reporting progress.
    async fn create_vm<P: ProgressCallback>(
        &self,
        config: &UtmVmConfig,
        progress_callback: &P,
    ) -> Result<UtmVmResult>;

    /// Start a UTM VM.
    fn start_vm(&self, vm_id: &str) -> Result<()>;

    /// Resize a UTM VM's disk to `size_gb`.
    fn resize_vm_disk(&self, vm_id: &str, size_gb: u32) -> Result<()>;

    /// Get the status of a UTM VM.
    fn vm_status(&self, vm_id: &str) -> Result<VmStatusInfo>;
}

/// Host system queries and Home Assistant reachability checks.
pub trait HostBackend {
    /// Host CPU/memory info for VM sizing limits.
    fn system_info(&self) -> Result<SystemInfo>;

    /// Whether the Home Assistant webserver is reachable at `ip`.
    async fn check_ha_ready(&self, ip: &str) -> bool;

    /// Whether Home Assistant has finished starting up at `ip`.
    async fn check_ha_updated(&self, ip: &str) -> bool;
}

/// hai-core's production backend.
///
/// Implements the backend traits by delegating to the domain modules. Each
/// `impl` lives in the module it forwards to: `ReleaseSource` in [`download`],
/// `DeviceBackend` in [`disk`], `ProxmoxBackend` in [`proxmox`], `UtmBackend`
/// in [`utm`] and `HostBackend` in [`host`].
#[derive(Debug, Clone, Copy, Default)]
pub struct Backend;

/// Trait for receiving progress updates during long-running operations.
///
/// This trait abstracts the progress reporting mechanism, allowing hai-core
/// to work with different frontends (Tauri desktop, TUI, etc.) without
/// coupling to any specific implementation.
///
/// # Example
///
/// ```ignore
/// use hai_core::{FlashProgress, ProgressCallback};
///
/// struct MyProgressHandler;
///
/// impl ProgressCallback for MyProgressHandler {
///     fn on_progress(&self, progress: FlashProgress) {
///         println!("Progress: {}%", progress.progress);
///     }
/// }
/// ```
pub trait ProgressCallback: Send + Sync {
    /// Called when progress is updated during an operation.
    ///
    /// Implementations should handle this method being called frequently
    /// during long-running operations like downloads and disk writes.
    fn on_progress(&self, progress: FlashProgress);
}

/// A no-op progress callback for use when progress reporting is not needed.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoOpProgress;

impl ProgressCallback for NoOpProgress {
    fn on_progress(&self, _progress: FlashProgress) {
        // Intentionally empty - used when progress is not needed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_noop_progress_callback() {
        let callback = NoOpProgress;
        let progress = FlashProgress {
            stage: FlashStage::Downloading,
            progress: 50,
            bytes_processed: 1000,
            total_bytes: 2000,
            message: "Test".to_string(),
        };

        // Should not panic
        callback.on_progress(progress);
    }
}
