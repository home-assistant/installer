/** One-shot failures for browser development and E2E tests, never native IPC. */
export function failMockOperation(operation: "flash" | "proxmox" | "utm") {
  if (!import.meta.env.DEV || "__TAURI__" in window) return;

  const key = "hai:mock-failure";
  const scenario = sessionStorage.getItem(key);
  // Shaped like the native CommandError rejections, codes included
  const failures: Record<
    string,
    { operation: string; code: string; message: string; retryable: boolean }
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
    "proxmox-install": {
      operation: "proxmox",
      code: "proxmox_api",
      message: "Proxmox API error: storage unavailable",
      retryable: false,
    },
    "utm-create": {
      operation: "utm",
      code: "utm",
      message: "UTM error: Automation permission denied",
      retryable: true,
    },
  };
  const failure = scenario ? failures[scenario] : undefined;
  if (failure?.operation !== operation) return;

  sessionStorage.removeItem(key);
  const { code, message, retryable } = failure;
  throw { code, message, retryable, details: {} };
}
