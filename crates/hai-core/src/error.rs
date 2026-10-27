//! Unified error types for hai-core

use thiserror::Error;

/// Error type for all hai-core operations
#[derive(Error, Debug)]
pub enum Error {
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Device not found: {0}")]
    DeviceNotFound(String),

    /// The reason is a fixed code for the local log; the text may hold paths.
    #[error("Device is busy: {1}")]
    DeviceBusy(BusyReason, String),

    #[error("Checksum mismatch: expected {expected}, got {actual}")]
    ChecksumMismatch { expected: String, actual: String },

    #[error("Permission denied: {0}")]
    PermissionDenied(crate::Message),

    #[error("Disk service unavailable: {0}")]
    DiskServiceUnavailable(String),

    #[error("Operation cancelled")]
    Cancelled,

    #[error("Proxmox API error: {0}")]
    ProxmoxApi(String),

    #[error("Proxmox session expired or invalid. Please reconnect to Proxmox.")]
    ProxmoxSessionExpired,

    /// The server presented a different certificate than the one the user
    /// trusted for this session. Reconnecting shows the new one to confirm.
    #[error("The Proxmox server's certificate changed. Reconnect to check it again.")]
    ProxmoxCertificateChanged,

    #[error("Proxmox two-factor authentication: {0}")]
    ProxmoxTwoFactor(crate::Message),
    /// Installer-authored guidance, without raw HTTP responses or request URLs.
    #[error("{0}")]
    ProxmoxActionRequired(crate::Message),

    /// GitHub's API limit was reached; installer-authored guidance with the wait time.
    #[error("{0}")]
    RateLimited(crate::Message),

    /// A service the installer needs, like the version service or GitHub,
    /// couldn't be reached or didn't answer usefully. Installer-authored
    /// guidance that names it, without request URLs or response bodies.
    #[error("{0}")]
    ServiceUnavailable(crate::Message),

    #[error("UTM error: {0}")]
    Utm(crate::Message),

    #[error("UTM operation outcome is unknown: {0}")]
    UtmOperationUncertain(crate::Message),

    #[error("{0}")]
    UtmVmCreated(crate::Message),

    #[error("Drive disconnected")]
    DriveDisconnected,

    #[error(
        "The drive is write-protected. If it's an SD card, slide the lock switch on its side up and try again."
    )]
    WriteProtected,

    #[error("Platform not supported: {0}")]
    UnsupportedPlatform(String),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),

    #[error("Download failed: {0}")]
    DownloadFailed(String),

    #[error("Extraction failed: {0}")]
    ExtractionFailed(String),

    #[error("Verification failed: {0}")]
    VerificationFailed(String),

    /// Known capacity is too small, or writing/flushing reported a full device;
    /// `written` is zero for preflight failures.
    #[error("Image is larger than the selected drive: image size {image_size} bytes; {written} bytes written")]
    ImageTooLarge {
        written: u64,
        image_size: u64,
        drive_size: Option<u64>,
    },

    /// The `hai-live` program for the live USB stick is not a static x86-64 Linux build.
    #[error("hai-live must be the Linux build (x86_64-unknown-linux-musl), not a Windows or macOS program")]
    LiveUsbInvalidHaiLive,

    /// The latest HAOS release can't be installed: no release or image for the
    /// board, no usable checksum, or an unexpected version.
    #[error("Home Assistant OS release can't be used: {0}")]
    ReleaseUnusable(String),

    /// Building the live USB disk image or ISO failed. May name local paths.
    #[error("Building the live USB media failed: {0}")]
    LiveUsbBuild(String),
}

/// Why a drive counts as busy. Reports show only this code, never the
/// message, so each path that refuses a drive gets its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BusyReason {
    /// The operating system refused the drive because something holds it
    InUse,
    /// A volume on the drive could not be unmounted, locked or dismounted
    UnmountFailed,
    /// A volume elsewhere could not be checked for whether it sits on the drive
    VolumeUnreadable,
    /// A volume on the drive also spans another disk
    VolumeSpansDisks,
    /// A volume on the drive changed while the write was being prepared
    VolumeChanged,
    /// The drive holds a system mount, active swap or active storage
    SystemStorage,
    /// Swap or Btrfs storage is active, but not which disk backs it
    UnknownBacking,
    /// Ejecting the drive failed
    EjectFailed,
}

impl BusyReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::InUse => "device_busy_in_use",
            Self::UnmountFailed => "device_busy_unmount_failed",
            Self::VolumeUnreadable => "device_busy_volume_unreadable",
            Self::VolumeSpansDisks => "device_busy_volume_spans_disks",
            Self::VolumeChanged => "device_busy_volume_changed",
            Self::SystemStorage => "device_busy_system_storage",
            Self::UnknownBacking => "device_busy_unknown_backing",
            Self::EjectFailed => "device_busy_eject_failed",
        }
    }
}

impl Error {
    /// This error as a parameter of another message. A catalog message stays
    /// a message, so the frontend translates it too; anything else is its
    /// English text.
    pub fn detail(&self) -> serde_json::Value {
        match self {
            Self::ProxmoxActionRequired(message)
            | Self::Utm(message)
            | Self::UtmOperationUncertain(message)
            | Self::UtmVmCreated(message) => serde_json::json!(message),
            other => serde_json::Value::String(other.to_string()),
        }
    }
}

/// Result type alias for hai-core operations
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_busy_reason_codes_are_distinct_busy_categories() {
        let reasons = [
            BusyReason::InUse,
            BusyReason::UnmountFailed,
            BusyReason::VolumeUnreadable,
            BusyReason::VolumeSpansDisks,
            BusyReason::VolumeChanged,
            BusyReason::SystemStorage,
            BusyReason::UnknownBacking,
            BusyReason::EjectFailed,
        ];
        let codes: std::collections::HashSet<_> =
            reasons.iter().map(|reason| reason.code()).collect();
        assert_eq!(codes.len(), reasons.len());
        assert!(codes.iter().all(|code| code.starts_with("device_busy_")));
    }
}
