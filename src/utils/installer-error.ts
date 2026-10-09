import { html } from "lit";
import { localize } from "../localization/localize.js";
import { formatBytes } from "../api/commands.js";
import { openExternalLink } from "./external-url.js";
import "../components/diagnostics-actions.js";

export interface InstallerError {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

const messages: Record<string, string> = {
  network: "Could not connect. Check your internet connection.",
  io: "Could not read or write a file. Check available storage and access permissions.",
  device_not_found:
    "The selected drive is no longer available. Select your drive again.",
  device_busy:
    "The drive is in use. Close any applications using it, then try again.",
  checksum_mismatch:
    "The downloaded image failed its integrity check. Installation stopped before writing the image.",
  disk_service_unavailable:
    "The system disk service is unavailable. Check that udisks2 is installed and running.",
  cancelled: "Installation was cancelled.",
  proxmox_api:
    "Proxmox could not complete the request. Check the server, account permissions, and connection.",
  proxmox_certificate_changed:
    "The Proxmox server's certificate changed. Reconnect to check it again.",
  drive_disconnected:
    "The storage device was disconnected. Reconnect it and select your drive again.",
  write_protected:
    "The drive is write-protected. Unlock the SD card or choose another drive.",
  unsupported_platform:
    "This installation method is not available on this computer. Choose another installation method.",
  json: "The installer received an unexpected response. Report the problem if it continues.",
  download_failed:
    "The image could not be downloaded. Check your connection and available storage.",
  extraction_failed:
    "The image could not be unpacked. Check available storage.",
  verification_failed:
    "The image could not be verified. Installation stopped to protect your device. See the installation help before continuing.",
  image_too_large:
    "The image does not fit on this drive. Choose a larger drive.",
  operation_in_progress:
    "An installation is already in progress. Wait for it to finish before starting another.",
  internal:
    "The installation stopped unexpectedly. Check the drive or virtual machine before starting again.",
};

/** Tauri rejects with JSON values, not JavaScript Error instances. */
export function installerError(
  error: unknown,
  fallback = "An unexpected error occurred"
): InstallerError {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    "retryable" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean"
  ) {
    const details =
      "details" in error &&
      error.details &&
      typeof error.details === "object" &&
      !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>)
        : {};
    let message = Object.prototype.hasOwnProperty.call(messages, error.code)
      ? messages[error.code]
      : error.message || fallback;
    if (
      error.code === "image_too_large" &&
      typeof details.image_size === "number" &&
      Number.isFinite(details.image_size) &&
      details.image_size > 0
    ) {
      message = `The image needs ${formatBytes(details.image_size)}.`;
      if (
        typeof details.drive_size === "number" &&
        Number.isFinite(details.drive_size) &&
        details.drive_size >= 0
      ) {
        message += ` This drive holds ${formatBytes(details.drive_size)}.`;
      }
      message += " Choose a larger drive.";
    }
    return { code: error.code, message, retryable: error.retryable, details };
  }
  // Retain readable legacy and local errors, but never guess retryability from text.
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : fallback;
  return {
    code: "unknown",
    message: message.trim() || fallback,
    retryable: false,
    details: {},
  };
}

/** Fixed destinations only: error text, paths, and credentials never enter URLs. */
export function renderErrorHelp() {
  const help = "https://www.home-assistant.io/installation/";
  // Reporting goes through the diagnostics dialog, which shows exactly what
  // a public issue would contain before anything leaves the installer
  return html`<p class="error-help">
    <a href=${help} @click=${(event: Event) => openExternalLink(event, help)}
      >${localize("common.installation_help")}</a
    >
    <span aria-hidden="true"> · </span>
    <diagnostics-actions></diagnostics-actions>
  </p>`;
}
