//! Public, credential-free error contract for Tauri commands.

use hai_core::{Error, Message};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Serialize, PartialEq)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: Value,
    /// The local log's category: the code, or a finer fixed code where one
    /// code covers several causes. Never sent to the frontend.
    #[serde(skip)]
    pub diagnostic: &'static str,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            details: json!({}),
            diagnostic: code,
        }
    }

    /// An error the frontend shows from its catalog, in the user's language.
    /// `message` keeps the English, for logs and older frontends.
    pub fn with_message(code: &'static str, message: &Message, retryable: bool) -> Self {
        Self {
            code,
            message: message.to_string(),
            retryable,
            details: json!({ "message_key": message.key, "message_params": message.params_json() }),
            diagnostic: code,
        }
    }

    /// A read-only query can be repeated after the user restores access or service.
    pub fn from_query(error: Error) -> Self {
        let mut error = Self::from(error);
        error.retryable = !matches!(
            error.code,
            "unsupported_platform"
                | "invalid_config"
                | "utm_operation_uncertain"
                | "proxmox_session_expired"
                | "proxmox_certificate_changed"
        );
        error
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl From<Error> for CommandError {
    fn from(error: Error) -> Self {
        let (code, message, retryable) = match &error {
            // Never serialize URLs, response bodies, or authentication data from remote errors.
            Error::Network(_) => ("network", "Could not connect. Check your internet connection.", true),
            Error::Io(_) => ("io", "Could not read or write a file. Check available storage and access permissions.", false),
            Error::DeviceNotFound(_) => ("device_not_found", "The selected drive is no longer available. Select your drive again.", false),
            Error::DeviceBusy(reason, _) => {
                let mut result = Self::new("device_busy", "The drive is in use. Close any applications using it.", true);
                result.diagnostic = reason.code();
                return result;
            }
            Error::ChecksumMismatch { .. } => ("checksum_mismatch", "The downloaded image failed its integrity check. Installation stopped before writing the image.", true),
            Error::PermissionDenied(message) => return Self::with_message("permission_denied", message, false),
            Error::DiskServiceUnavailable(_) => ("disk_service_unavailable", "The system disk service is unavailable. Check that udisks2 is installed and running.", false),
            Error::Cancelled => ("cancelled", "Installation was cancelled.", true),
            Error::ProxmoxApi(_) => ("proxmox_api", "Proxmox could not complete the request. Check the server, account permissions, and connection.", false),
            // The frontend shows these in the user's language, by key
            Error::ProxmoxActionRequired(message) => return Self::with_message("proxmox_action_required", message, false),
            // Reconnecting is the action, not repeating the request
            Error::ProxmoxSessionExpired => ("proxmox_session_expired", "Proxmox session expired or invalid. Please reconnect to Proxmox.", false),
            // Same recovery: reconnecting shows the new certificate to confirm
            Error::ProxmoxCertificateChanged => ("proxmox_certificate_changed", "The Proxmox server's certificate changed. Reconnect to check it again.", false),
            // Installer-authored guidance for the authenticator code, never a server response
            Error::ProxmoxTwoFactor(message) => return Self::with_message("proxmox_two_factor", message, false),
            Error::Utm(message) => return Self::with_message("utm", message, true),
            Error::UtmOperationUncertain(message) => return Self::with_message("utm_operation_uncertain", message, false),
            Error::UtmVmCreated(message) => return Self::with_message("utm_vm_created", message, false),
            Error::DriveDisconnected => ("drive_disconnected", "The drive was disconnected. Reconnect it and select it again.", false),
            Error::WriteProtected => ("write_protected", "The drive is write-protected. Unlock the SD card or choose another drive.", false),
            Error::UnsupportedSectorSize(_) => ("unsupported_sector_size", "This drive uses a sector size Home Assistant can't start from. Choose another drive.", false),
            Error::UnsupportedPlatform(_) => ("unsupported_platform", "This installation method is not available on this computer.", false),
            Error::Json(_) => ("json", "The installer received an unexpected response.", false),
            Error::InvalidConfig(message) => ("invalid_config", message.as_str(), false),
            // Installer-authored, and the wait time is what makes it actionable
            Error::RateLimited(message) => return Self::with_message("rate_limited", message, true),
            // Names the service, so the frontend doesn't say the image failed
            Error::ServiceUnavailable(message) => return Self::with_message("network", message, true),
            Error::DownloadFailed(_) => ("download_failed", "The image could not be downloaded. Check your connection and available storage.", true),
            Error::ExtractionFailed(_) => ("extraction_failed", "The downloaded image is damaged and couldn't be unpacked. Try again to download a new copy.", true),
            Error::VerificationFailed(_) => ("verification_failed", "The image could not be verified. Installation stopped to protect your device. See the installation help before continuing.", false),
            Error::ImageTooLarge { written, image_size, drive_size } => {
                let mut result = Self::new("image_too_large", "The image does not fit on this drive. Choose a larger drive.", false);
                result.details = json!({ "written": written, "image_size": image_size, "drive_size": drive_size });
                return result;
            }
            Error::LiveUsbInvalidHaiLive => ("hai_live_invalid", "The program for the USB stick (hai-live) is not the Linux build. Rebuild it for x86_64-unknown-linux-musl, then try again.", true),
            Error::ReleaseUnusable(_) => ("release_unavailable", "The latest Home Assistant OS release can't be used right now. Try again later.", true),
            Error::LiveUsbBuild(_) => ("image_build_failed", "The bootable media could not be built. Check available storage, then try again.", true),
        };
        Self::new(code, message, retryable)
    }
}

impl From<std::io::Error> for CommandError {
    fn from(error: std::io::Error) -> Self {
        Error::Io(error).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_capacity_without_parsing_messages() {
        let error = CommandError::from(Error::ImageTooLarge {
            written: 0,
            image_size: 2048,
            drive_size: Some(1024),
        });
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({
                "code": "image_too_large", "message": "The image does not fit on this drive. Choose a larger drive.",
                "retryable": false, "details": { "written": 0, "image_size": 2048, "drive_size": 1024 }
            })
        );
    }

    #[test]
    fn release_and_unpacking_failures_name_what_failed() {
        let release = CommandError::from(Error::ReleaseUnusable("No raw image in release".into()));
        assert_eq!(release.code, "release_unavailable");
        assert!(release.retryable);

        // A damaged download, not this computer's storage
        let extraction = CommandError::from(Error::ExtractionFailed("corrupt".into()));
        assert!(extraction.message.contains("damaged"), "{extraction}");
        assert!(!extraction.message.contains("storage"), "{extraction}");
        assert!(extraction.retryable);
    }

    #[test]
    fn busy_reason_reaches_the_log_but_not_the_frontend() {
        let error = CommandError::from(Error::DeviceBusy(
            hai_core::BusyReason::VolumeUnreadable,
            "Cannot inspect volume \\\\?\\Volume{private}: Access is denied".into(),
        ));
        assert_eq!(error.code, "device_busy");
        assert_eq!(error.diagnostic, "device_busy_volume_unreadable");

        let serialized = serde_json::to_string(&error).unwrap();
        assert!(!serialized.contains("diagnostic"), "{serialized}");
        assert!(!serialized.contains("private"), "{serialized}");
    }

    #[test]
    fn remote_messages_cannot_leak_credentials() {
        for error in [
            Error::ProxmoxApi("password=secret ticket=secret".into()),
            Error::DownloadFailed("https://user:secret@example.com/?token=secret".into()),
            Error::LiveUsbBuild(r"ISO: C:\Users\secret\x.iso".into()),
        ] {
            assert!(!serde_json::to_string(&CommandError::from(error))
                .unwrap()
                .contains("secret"));
        }
    }

    #[test]
    fn installer_authored_proxmox_guidance_is_preserved() {
        let error = CommandError::from(Error::ProxmoxActionRequired(hai_core::message!(
            "backend.proxmox.vm_id_unavailable",
            vm_id = 100,
        )));
        assert_eq!(error.code, "proxmox_action_required");
        assert_eq!(
            error.message,
            "VM ID 100 can't be used. Choose a different ID."
        );
        assert!(!error.retryable);
        // What the frontend needs to show it in the user's language
        assert_eq!(
            error.details,
            json!({
                "message_key": "backend.proxmox.vm_id_unavailable",
                "message_params": { "vm_id": 100 }
            })
        );
    }

    #[test]
    fn read_queries_can_retry_after_service_or_permission_changes() {
        for error in [
            Error::PermissionDenied(hai_core::message!("backend.disk.not_authorized")),
            Error::DiskServiceUnavailable("service stopped".into()),
            Error::ProxmoxApi("network failure".into()),
        ] {
            assert!(CommandError::from_query(error).retryable);
        }
        assert!(!CommandError::from_query(Error::UnsupportedPlatform("UTM".into())).retryable);
        assert!(
            CommandError::from(Error::Utm(hai_core::message!(
                "backend.utm.automation_denied"
            )))
            .retryable
        );
        assert!(
            !CommandError::from(Error::UtmOperationUncertain(hai_core::message!(
                "backend.utm.no_answer",
                detail = "AppleEvent timed out (-1712)",
            )))
            .retryable
        );
    }

    #[test]
    fn uncertain_import_and_permission_guidance_are_preserved_without_retry() {
        let uncertain = CommandError::from(Error::UtmOperationUncertain(hai_core::message!(
            "backend.utm.no_answer",
            detail = "AppleEvent timed out (-1712)",
        )));
        assert_eq!(uncertain.message, "AppleEvent timed out (-1712)");
        assert_eq!(uncertain.details["message_key"], "backend.utm.no_answer");
        assert!(!uncertain.retryable);

        let permission = CommandError::from(Error::PermissionDenied(hai_core::message!(
            "backend.disk.run_as_administrator"
        )));
        assert!(permission.message.contains("Run as administrator"));
        assert_eq!(
            permission.details["message_key"],
            "backend.disk.run_as_administrator"
        );
        assert!(!permission.retryable);
    }
}
