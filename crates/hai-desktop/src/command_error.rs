//! Public, credential-free error contract for Tauri commands.

use hai_core::Error;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Serialize, PartialEq)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: Value,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            details: json!({}),
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
            Error::DeviceBusy(_) => ("device_busy", "The drive is in use. Close any applications using it.", true),
            Error::ChecksumMismatch { .. } => ("checksum_mismatch", "The downloaded image failed its integrity check. Installation stopped before writing the image.", true),
            Error::PermissionDenied(message) => ("permission_denied", message.as_str(), false),
            Error::DiskServiceUnavailable(_) => ("disk_service_unavailable", "The system disk service is unavailable. Check that udisks2 is installed and running.", false),
            Error::Cancelled => ("cancelled", "Installation was cancelled.", true),
            Error::ProxmoxApi(_) => ("proxmox_api", "Proxmox could not complete the request. Check the server, account permissions, and connection.", false),
            Error::ProxmoxActionRequired(message) => ("proxmox_action_required", message.as_str(), false),
            // Reconnecting is the action, not repeating the request
            Error::ProxmoxSessionExpired => ("proxmox_session_expired", "Proxmox session expired or invalid. Please reconnect to Proxmox.", false),
            // Same recovery: reconnecting shows the new certificate to confirm
            Error::ProxmoxCertificateChanged => ("proxmox_certificate_changed", "The Proxmox server's certificate changed. Reconnect to check it again.", false),
            // Installer-authored guidance for the authenticator code, never a server response
            Error::ProxmoxTwoFactor(message) => ("proxmox_two_factor", message.as_str(), false),
            Error::Utm(message) => ("utm", message.as_str(), true),
            Error::UtmOperationUncertain(message) => ("utm_operation_uncertain", message.as_str(), false),
            Error::UtmVmCreated(message) => ("utm_vm_created", message.as_str(), false),
            Error::DriveDisconnected => ("drive_disconnected", "The drive was disconnected. Reconnect it and select it again.", false),
            Error::WriteProtected => ("write_protected", "The drive is write-protected. Unlock the SD card or choose another drive.", false),
            Error::UnsupportedPlatform(_) => ("unsupported_platform", "This installation method is not available on this computer.", false),
            Error::Json(_) => ("json", "The installer received an unexpected response.", false),
            Error::InvalidConfig(message) => ("invalid_config", message.as_str(), false),
            // Installer-authored, and the wait time is what makes it actionable
            Error::RateLimited(message) => ("rate_limited", message.as_str(), true),
            Error::DownloadFailed(_) => ("download_failed", "The image could not be downloaded. Check your connection and available storage.", true),
            Error::ExtractionFailed(_) => ("extraction_failed", "The image could not be unpacked. Check available storage.", true),
            Error::VerificationFailed(_) => ("verification_failed", "The image could not be verified. Installation stopped to protect your device. See the installation help before continuing.", false),
            Error::ImageTooLarge { .. } => ("image_too_large", "The image does not fit on this drive. Choose a larger drive.", false),
        };
        let mut result = Self::new(code, message, retryable);
        if let Error::ImageTooLarge {
            written,
            image_size,
            drive_size,
        } = error
        {
            result.details =
                json!({ "written": written, "image_size": image_size, "drive_size": drive_size });
        }
        result
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
    fn remote_messages_cannot_leak_credentials() {
        for error in [
            Error::ProxmoxApi("password=secret ticket=secret".into()),
            Error::DownloadFailed("https://user:secret@example.com/?token=secret".into()),
        ] {
            assert!(!serde_json::to_string(&CommandError::from(error))
                .unwrap()
                .contains("secret"));
        }
    }

    #[test]
    fn installer_authored_proxmox_guidance_is_preserved() {
        let error = CommandError::from(Error::ProxmoxActionRequired(
            "VM ID 100 can't be used. Choose a different ID.".into(),
        ));
        assert_eq!(error.code, "proxmox_action_required");
        assert!(error.message.contains("Choose a different ID"));
        assert!(!error.retryable);
    }

    #[test]
    fn read_queries_can_retry_after_service_or_permission_changes() {
        for error in [
            Error::PermissionDenied("Permission required".into()),
            Error::DiskServiceUnavailable("service stopped".into()),
            Error::ProxmoxApi("network failure".into()),
        ] {
            assert!(CommandError::from_query(error).retryable);
        }
        assert!(!CommandError::from_query(Error::UnsupportedPlatform("UTM".into())).retryable);
        assert!(
            CommandError::from(Error::Utm(
                "Enable Automation access, then try again".into()
            ))
            .retryable
        );
        assert!(
            !CommandError::from(Error::UtmOperationUncertain(
                "Check UTM before retrying".into()
            ))
            .retryable
        );
    }

    #[test]
    fn uncertain_import_and_permission_guidance_are_preserved_without_retry() {
        for error in [
            Error::UtmOperationUncertain("Check UTM before removing the retained source".into()),
            Error::PermissionDenied("Run as administrator".into()),
        ] {
            let expected = match &error {
                Error::UtmOperationUncertain(message) | Error::PermissionDenied(message) => {
                    message.clone()
                }
                _ => unreachable!(),
            };
            let error = CommandError::from(error);
            assert_eq!(error.message, expected);
            assert!(!error.retryable);
        }
    }
}
