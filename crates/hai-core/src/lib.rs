//! hai-core - Core library for Home Assistant Installer
//!
//! This library provides the shared business logic for the Home Assistant
//! Installer, including device enumeration, image downloading, disk writing,
//! and VM provisioning for Proxmox and UTM.
//!
//! The library is designed to be frontend-agnostic, supporting both the
//! Tauri desktop application and potential TUI implementations.

// The backend traits use `async fn`. They are only ever used through the
// concrete `Backend` type (static dispatch, never `dyn`), so the returned
// futures' `Send`-ness is inferred at each call site. The missing `Send` bound
// the lint warns about therefore cannot bite us.
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
pub use types::*;

use std::path::{Path, PathBuf};

// ===========================================================================
// Backend traits
// ===========================================================================
//
// One trait per backend concern. They describe the surface the application
// uses from hai-core, so that a frontend can be wired to an alternative
// implementation (for example a mock) without touching the domain modules.

/// Release metadata and image download.
pub trait ReleaseSource {
    /// Fetch the device manifest (list of supported boards).
    async fn get_device_manifest(&self) -> Result<DeviceManifest>;

    /// Fetch a HAOS release by version, or the latest when `version == "latest"`.
    async fn get_haos_release(&self, version: &str) -> Result<HaosRelease>;

    /// Download an image to `dest_path`, reporting progress.
    async fn download_image<P: ProgressCallback>(
        &self,
        url: &str,
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

    /// Check whether a newer installer release is available.
    async fn check_for_updates(&self) -> Result<UpdateInfo>;

    /// Directory where downloaded images are cached.
    fn cache_dir(&self) -> Result<PathBuf>;
}

/// Block-device enumeration and raw image writing.
///
/// `list_devices` returns every block device the platform reports, internal
/// disks included, and `write_image` writes to whatever device id it is given.
/// Neither checks that the target is safe to overwrite, that is the caller's
/// responsibility.
pub trait DeviceBackend {
    /// List all block devices on the system.
    async fn list_devices(&self) -> Result<Vec<BlockDevice>>;

    /// Write an image to the device with this id, reporting progress.
    ///
    /// Performs no identity or removability check of its own.
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

/// Check if mock mode is enabled via environment variable.
///
/// Mock mode is enabled when the `HA_INSTALLER_MOCK` environment variable
/// is set to "1" or "true". This is useful for testing and development.
pub fn is_mock_enabled() -> bool {
    match std::env::var("HA_INSTALLER_MOCK") {
        Ok(val) => val == "1" || val.to_lowercase() == "true",
        Err(_) => false,
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

    #[test]
    fn test_mock_mode_default_disabled() {
        // Remove the env var if it exists
        std::env::remove_var("HA_INSTALLER_MOCK");
        assert!(!is_mock_enabled());
    }
}
