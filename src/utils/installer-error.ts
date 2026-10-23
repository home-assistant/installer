import { html } from "lit";
import { localize, localizeBackend } from "../localization/localize.js";
import { formatBytes } from "../api/commands.js";
import { openExternalLink } from "./external-url.js";
import "../components/diagnostics-actions.js";

export interface InstallerError {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

/** Text by error code, in the user's language. Unknown codes keep the backend's text. */
const messages: Record<string, () => string> = {
  network: () => localize("utils.installer_error.network"),
  io: () => localize("utils.installer_error.io"),
  device_not_found: () => localize("utils.installer_error.device_not_found"),
  device_busy: () => localize("utils.installer_error.device_busy"),
  checksum_mismatch: () => localize("utils.installer_error.checksum_mismatch"),
  disk_service_unavailable: () =>
    localize("utils.installer_error.disk_service_unavailable"),
  cancelled: () => localize("utils.installer_error.cancelled"),
  proxmox_api: () => localize("utils.installer_error.proxmox_api"),
  proxmox_certificate_changed: () =>
    localize("utils.installer_error.proxmox_certificate_changed"),
  proxmox_session_expired: () => localize("common.proxmox.session_expired"),
  // The backend's text names internals such as file names or parse errors
  invalid_config: () => localize("utils.installer_error.invalid_config"),
  drive_disconnected: () =>
    localize("utils.installer_error.drive_disconnected"),
  write_protected: () => localize("utils.installer_error.write_protected"),
  unsupported_platform: () =>
    localize("utils.installer_error.unsupported_platform"),
  json: () => localize("utils.installer_error.json"),
  download_failed: () => localize("utils.installer_error.download_failed"),
  extraction_failed: () => localize("utils.installer_error.extraction_failed"),
  verification_failed: () =>
    localize("utils.installer_error.verification_failed"),
  image_too_large: () => localize("utils.installer_error.image_too_large"),
  operation_in_progress: () =>
    localize("utils.installer_error.operation_in_progress"),
  internal: () => localize("utils.installer_error.internal"),
};

/** Tauri rejects with JSON values, not JavaScript Error instances. */
export function installerError(
  error: unknown,
  fallback = localize("utils.installer_error.unexpected")
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
    const byCode = Object.prototype.hasOwnProperty.call(messages, error.code)
      ? messages[error.code]
      : undefined;
    let message =
      localizeBackend(details.message_key, details.message_params) ??
      byCode?.() ??
      (error.message || fallback);
    if (
      error.code === "image_too_large" &&
      typeof details.image_size === "number" &&
      Number.isFinite(details.image_size) &&
      details.image_size > 0
    ) {
      const imageSize = formatBytes(details.image_size);
      message =
        typeof details.drive_size === "number" &&
        Number.isFinite(details.drive_size) &&
        details.drive_size >= 0
          ? localize("utils.installer_error.image_too_large_for_drive", {
              image_size: imageSize,
              drive_size: formatBytes(details.drive_size),
            })
          : localize("utils.installer_error.image_too_large_with_size", {
              image_size: imageSize,
            });
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

/** Failures of the drive itself, whatever stage they come from */
const DRIVE_FAILURES = [
  "device_not_found",
  "drive_disconnected",
  "drive_too_small",
  "image_too_large",
  "write_protected",
];

/**
 * Whether the failure with `code` is the drive's, so another drive can fix
 * it. A read or write error, or a failed check, is the drive's only once
 * the write reached it: before that, it is about this computer's storage or
 * the image.
 */
export function isDriveFailure(code: string, reachedDrive: boolean): boolean {
  return (
    DRIVE_FAILURES.includes(code) ||
    (reachedDrive && (code === "io" || code === "verification_failed"))
  );
}

/** Fixed destinations only: error text, paths, and credentials never enter URLs. */
export function renderErrorHelp() {
  const help = "https://www.home-assistant.io/installation/";
  // Reporting goes through the diagnostics dialog, which shows exactly what
  // a public issue would contain before anything leaves the installer
  return html`<p class="error-help">
    <a href=${help} @click=${openExternalLink}
      >${localize("common.installation_help")}</a
    >
    <span aria-hidden="true"> · </span>
    <diagnostics-actions></diagnostics-actions>
  </p>`;
}
