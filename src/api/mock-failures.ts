import { isTauri } from "@tauri-apps/api/core";

/** One-shot failures for browser development and E2E tests, never native IPC. */
export function failMockOperation(
  operation: "flash" | "proxmox" | "proxmox-download" | "utm" | "update"
) {
  if (!import.meta.env.DEV || isTauri()) return;

  const key = "hai:mock-failure";
  const scenario = sessionStorage.getItem(key);
  // Shaped like the native CommandError rejections, codes included
  const failures: Record<
    string,
    {
      operation: string;
      code: string;
      message: string;
      retryable: boolean;
      details?: Record<string, unknown>;
    }
  > = {
    "flash-write": {
      operation: "flash",
      code: "device_busy",
      message: "Write failed: I/O error",
      retryable: true,
    },
    "flash-disconnected": {
      operation: "flash",
      code: "drive_disconnected",
      message: "Drive disconnected",
      retryable: false,
    },
    "flash-permission": {
      operation: "flash",
      code: "permission_denied",
      message: "Administrator access was denied",
      retryable: false,
      details: { message_key: "backend.disk.admin_denied", message_params: {} },
    },
    "proxmox-install": {
      operation: "proxmox",
      code: "proxmox_api",
      message: "Proxmox API error: storage unavailable",
      retryable: false,
    },
    // Before the VM is being created, so the native install keeps its retry
    "proxmox-download": {
      operation: "proxmox-download",
      code: "download_failed",
      message: "Download failed: connection reset",
      retryable: true,
    },
    "utm-create": {
      operation: "utm",
      code: "utm",
      message: "UTM error: Automation permission denied",
      retryable: true,
      // The native UTM errors always come from the catalog
      details: {
        message_key: "backend.utm.automation_denied",
        message_params: {},
      },
    },
    "update-install": {
      operation: "update",
      code: "update_failed",
      message: "The update could not be installed.",
      retryable: true,
    },
  };
  const failure = scenario ? failures[scenario] : undefined;
  if (failure?.operation !== operation) return;

  sessionStorage.removeItem(key);
  const { code, message, retryable, details = {} } = failure;
  throw { code, message, retryable, details };
}
