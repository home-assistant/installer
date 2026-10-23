import { formatNumber, localize } from "../localization/localize.js";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { failMockOperation } from "./mock-failures.js";
import { getPlatform } from "../utils/platform.js";
import type {
  BlockDevice,
  DeviceManifest,
  FlashProgress,
  FlashRequest,
  FlashResult,
  HaSetupStatus,
  HaosRelease,
  ProxmoxCredentials,
  ProxmoxNode,
  ProxmoxSession,
  ProxmoxStorage,
  ProxmoxVmConfig,
  ProxmoxBridge,
  ProxmoxVmResult,
  SystemInfo,
  UtmStatus,
  UtmVmConfig,
  VmStatusInfo,
} from "./types.js";

export type { VmStatusInfo } from "./types.js";

/**
 * Whether to answer with mock data because there's no Tauri backend, as in
 * the Vite dev server that the E2E tests drive.
 *
 * Only in development builds: the mock reports a successful flash without
 * writing anything, so a production build must never fall back to it. The
 * check sits at each call site rather than in here, so production builds see
 * `if (false)` and Vite drops the mock branches and the fixture data.
 */
const MOCK_ALLOWED = import.meta.env.DEV;

/** Check the Home Assistant version service before starting a flow. */
export async function checkConnection(): Promise<void> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return;
  }
  return invoke<void>("check_connection");
}

/**
 * Call `onBlocked` whenever the backend held back closing the app because an
 * installation is still running. Resolves to a function that stops listening.
 */
export async function onCloseBlocked(
  onBlocked: () => void
): Promise<() => void> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return () => {};
  }
  return listen("close-blocked", () => onBlocked());
}

/** Quit the app, even though an installation is still running. */
export async function quitAnyway(): Promise<void> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return;
  }
  return invoke<void>("quit_anyway");
}

// A string check rather than `isTauri()`, so CI can find the browser mock in a
// production bundle.
function isBrowserOnly(): boolean {
  return typeof window !== "undefined" && !("isTauri" in window);
}

// Import mock data for browser-only mode
import {
  MOCK_BLOCK_DEVICES,
  MOCK_HAOS_RELEASE,
  MOCK_MANIFEST,
} from "./mock-data.js";

/**
 * List available block devices (SD cards, USB drives, etc.)
 */
export async function listBlockDevices(): Promise<BlockDevice[]> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return MOCK_BLOCK_DEVICES;
  }
  return invoke<BlockDevice[]>("list_block_devices");
}

/**
 * Flash an image to a device with progress updates.
 * @param request The flash request parameters
 * @param onProgress Callback for progress updates
 * @param attempt Names this flash, so `cancelFlash` can never stop another
 */
export async function flashImage(
  request: FlashRequest,
  onProgress: (progress: FlashProgress) => void,
  attempt: string
): Promise<FlashResult> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    // Simulate flash progress in browser-only mode
    return simulateFlashProgress(onProgress, attempt);
  }

  const channel = new Channel<FlashProgress>();

  channel.onmessage = (progress) => {
    onProgress(progress);
  };

  return invoke<FlashResult>("flash_image", {
    request,
    attempt,
    progressChannel: channel,
  });
}

/** The simulated flash in browser-only mode, and whether it was stopped. */
let mockFlashAttempt: string | undefined;
let mockFlashCancelled = false;

/**
 * Ask the flash started as `attempt` to stop. `flashImage` then rejects with
 * `cancelled` once nothing touches the drive anymore.
 */
export async function cancelFlash(attempt: string): Promise<void> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    if (attempt === mockFlashAttempt) mockFlashCancelled = true;
    return;
  }
  return invoke<void>("cancel_flash", { attempt });
}

/**
 * Simulate flash progress for browser-only mode. No view shows a progress
 * event's `message`, so the mocks leave it empty instead of making
 * translators translate it.
 */
async function simulateFlashProgress(
  onProgress: (progress: FlashProgress) => void,
  attempt: string
): Promise<FlashResult> {
  const compressedSize = 400 * 1024 * 1024; // 400 MB compressed
  const extractedSize = 2 * 1024 * 1024 * 1024; // 2 GB extracted

  const stages: Array<{
    stage: FlashProgress["stage"];
    totalBytes: number;
    steps: number;
    delay: number;
  }> = [
    {
      stage: "downloading",
      totalBytes: compressedSize,
      steps: 30,
      delay: 150,
    },
    {
      stage: "extracting",
      // Measured against the compressed archive, the only size known up front
      totalBytes: compressedSize,
      steps: 10,
      delay: 100,
    },
    {
      stage: "writing",
      totalBytes: extractedSize,
      steps: 35,
      delay: 175,
    },
    {
      stage: "verifying",
      totalBytes: extractedSize,
      steps: 15,
      delay: 150,
    },
    {
      stage: "finalizing",
      totalBytes: 0,
      steps: 10,
      delay: 100,
    },
  ];

  mockFlashAttempt = attempt;
  mockFlashCancelled = false;

  for (const { stage, totalBytes, steps, delay } of stages) {
    for (let step = 0; step <= steps; step++) {
      // Shaped like the native rejection
      if (mockFlashCancelled) {
        throw {
          code: "cancelled",
          message: "Installation was cancelled.",
          retryable: true,
          details: {},
        };
      }

      // Each stage counts from 0 to 100 on its own, like the backend
      const stageProgress = (step * 100) / steps;

      onProgress({
        stage,
        progress: Math.round(stageProgress),
        bytes_processed: Math.round((totalBytes * stageProgress) / 100),
        total_bytes: totalBytes,
        message: "",
      });

      if (stage === "writing" && step === 0) failMockOperation("flash");

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  onProgress({
    stage: "complete",
    progress: 100,
    bytes_processed: extractedSize,
    total_bytes: extractedSize,
    message: "",
  });

  return {
    duration_secs: 45,
  };
}

/**
 * Get the device manifest.
 */
export async function getManifest(): Promise<DeviceManifest> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return MOCK_MANIFEST;
  }
  return invoke<DeviceManifest>("get_manifest");
}

/**
 * Format bytes, or bytes per second, using decimal units, matching storage
 * manufacturers.
 */
export function formatBytes(bytes: number, perSecond = false): string {
  if (!Number.isFinite(bytes) || bytes < 0)
    return localize("common.unknown_size");

  const k = 1000;
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];
  const i = Math.max(
    0,
    Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
  );

  // Do not round a drive just below a capacity threshold up to that threshold.
  const value = Math.floor((bytes / Math.pow(k, i)) * 10) / 10;
  return formatNumber(value, {
    style: "unit",
    unit: perSecond ? `${units[i]}-per-second` : units[i],
    // English's short form is "500 byte"
    unitDisplay: i === 0 ? "long" : "short",
    // Grouping would turn the oversized "1000 TB" clamp into "1,000 TB".
    useGrouping: false,
  });
}

/**
 * Get HAOS release information.
 * @param version Optional specific version to fetch (defaults to latest stable)
 * @param board Board whose stable release should be shown
 */
export async function getHaosRelease(
  version?: string,
  board?: string
): Promise<HaosRelease> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return MOCK_HAOS_RELEASE;
  }
  return invoke<HaosRelease>("get_haos_release", { version, board });
}

/** Get the stable release for the backend's UTM download architecture. */
export async function getUtmHaosRelease(): Promise<HaosRelease> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return MOCK_HAOS_RELEASE;
  }
  return invoke<HaosRelease>("get_utm_haos_release");
}

// ============================================================================
// System Info Commands
// ============================================================================

/**
 * Get system information (CPU cores and memory) for VM configuration limits.
 */
export async function getSystemInfo(): Promise<SystemInfo> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return {
      cpu_cores: 10,
      memory_mb: 32768, // 32 GB
    };
  }
  return invoke<SystemInfo>("get_system_info");
}

// ============================================================================
// UTM Commands (macOS only)
// ============================================================================

/** Whether this computer can run a UTM install: only Apple silicon Macs can. */
export async function isUtmSupported(): Promise<boolean> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return getPlatform() === "macos";
  }
  return invoke<boolean>("utm_supported");
}

/**
 * Check if UTM is installed and get its status.
 */
export async function checkUtmStatus(): Promise<UtmStatus> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    // Mock: UTM is installed
    return {
      installed: true,
      path: "/Applications/UTM.app",
      version: "4.5.0",
    };
  }
  return invoke<UtmStatus>("check_utm_status");
}

/**
 * Ask macOS whether the installer may control UTM. The first time this shows
 * the Automation prompt and opens UTM; it resolves once the user answered.
 */
export async function checkUtmAutomation(): Promise<void> {
  if (MOCK_ALLOWED && isBrowserOnly()) return;
  return invoke<void>("check_utm_automation");
}

/** Release a temporary image which was not consumed by VM creation. */
export async function discardUtmImage(imagePath: string): Promise<void> {
  if (MOCK_ALLOWED && isBrowserOnly()) return;
  await invoke("discard_utm_image", { imagePath });
}

/**
 * Download the HAOS qcow2 image for UTM.
 * @param onProgress Callback for progress updates
 * @param attempt Names this download, so `cancelVmInstall` can never stop another
 * @returns Path to the downloaded qcow2 file
 */
export async function downloadUtmImage(
  onProgress: (progress: FlashProgress) => void,
  attempt: string
): Promise<string> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    // Simulate download progress in browser-only mode
    return simulateUtmDownload(onProgress, attempt);
  }

  const channel = new Channel<FlashProgress>();

  channel.onmessage = (progress) => {
    onProgress(progress);
  };

  return invoke<string>("download_utm_image", {
    attempt,
    progressChannel: channel,
  });
}

/** The simulated VM install in browser-only mode, and whether it was stopped. */
let mockVmAttempt: string | undefined;
let mockVmCancelled = false;

/** Reject like the native command does after a stop. */
function throwIfMockVmCancelled(): void {
  if (!mockVmCancelled) return;

  throw {
    code: "cancelled",
    message: "Installation was cancelled.",
    retryable: true,
    details: {},
  };
}

/**
 * Ask the Proxmox install or UTM download started as `attempt` to stop. It
 * then rejects with `cancelled`. Once the virtual machine is being created,
 * it runs to the end instead.
 */
export async function cancelVmInstall(attempt: string): Promise<void> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    if (attempt === mockVmAttempt) mockVmCancelled = true;
    return;
  }
  return invoke<void>("cancel_vm_install", { attempt });
}

/**
 * Simulate UTM download for browser-only mode
 */
async function simulateUtmDownload(
  onProgress: (progress: FlashProgress) => void,
  attempt: string
): Promise<string> {
  const stages: Array<{
    stage: FlashProgress["stage"];
    steps: number;
    delay: number;
  }> = [
    {
      stage: "downloading",
      steps: 20,
      delay: 100,
    },
    {
      stage: "extracting",
      steps: 10,
      delay: 100,
    },
  ];

  const compressedSize = 400 * 1024 * 1024; // 400 MB compressed
  mockVmAttempt = attempt;
  mockVmCancelled = false;

  for (const { stage, steps, delay } of stages) {
    for (let step = 0; step <= steps; step++) {
      throwIfMockVmCancelled();
      // Each stage counts from 0 to 100 on its own, like the backend; both
      // measure against the compressed image, extraction included
      const stageProgress = (step * 100) / steps;

      onProgress({
        stage,
        progress: Math.round(stageProgress),
        bytes_processed: Math.round((compressedSize * stageProgress) / 100),
        total_bytes: compressedSize,
        message: "",
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  onProgress({
    stage: "complete",
    progress: 100,
    bytes_processed: 0,
    total_bytes: 0,
    message: "",
  });

  return "/tmp/mock-haos.qcow2";
}

/**
 * Create a Home Assistant VM in UTM.
 * @param config The VM configuration
 * @returns The VM ID if successful
 */
export async function createUtmVm(config: UtmVmConfig): Promise<string> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    failMockOperation("utm");
    // Simulate VM creation
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return "mock-vm-id-12345";
  }
  return invoke<string>("create_utm_vm", { config });
}

/**
 * Start a UTM VM.
 * @param vmId The VM ID to start
 */
export async function startUtmVm(vmId: string): Promise<void> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return;
  }
  return invoke<void>("start_utm_vm", { vmId });
}

/**
 * Get the status of a UTM VM including its IP address if available.
 * @param vmId The VM ID to check
 * @returns VM status and IP address
 */
export async function getUtmVmStatus(vmId: string): Promise<VmStatusInfo> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return {
      status: "started",
      ip_address: "192.168.1.100",
    };
  }
  return invoke<VmStatusInfo>("get_utm_vm_status", { vmId });
}

/**
 * Check if Home Assistant webserver is ready at the given IP address.
 * @param ipAddress The IP address to check
 * @returns True if the webserver is reachable on port 80
 */
export async function checkHaReady(ipAddress: string): Promise<boolean> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return true;
  }
  return invoke<boolean>("check_ha_ready", { ipAddress });
}

/**
 * Check if Home Assistant has finished updating by checking the manifest.json endpoint.
 * @param ipAddress The IP address to check
 * @returns True if manifest.json returns 200 OK
 */
export async function checkHaUpdated(ipAddress: string): Promise<boolean> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return true;
  }
  return invoke<boolean>("check_ha_updated", { ipAddress });
}

/**
 * What Supervisor reports while it installs Home Assistant, read from the
 * landing page at the given IP address.
 * @returns The Core download's progress and the problems holding it up, or
 * null without a full answer from the landing page, as once Home Assistant
 * runs
 */
export async function getHaSetupStatus(
  ipAddress: string
): Promise<HaSetupStatus | null> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return null;
  }
  return invoke<HaSetupStatus | null>("get_ha_setup_status", { ipAddress });
}

// ============================================================================
// Proxmox VE Commands
// ============================================================================

/** Store for the current Proxmox session (browser-only mock) */
let mockProxmoxSession: ProxmoxSession | null = null;

/** Inspect TLS trust before authenticating. A fingerprint requires user approval. */
export async function proxmoxCertificateFingerprint(
  serverUrl: string
): Promise<string | null> {
  if (MOCK_ALLOWED && isBrowserOnly()) return null;
  return invoke<string | null>("proxmox_certificate_fingerprint", {
    serverUrl,
  });
}

/**
 * Connect to a Proxmox VE server and authenticate.
 * @param credentials Server URL, username, and password
 * @returns Session with authentication ticket and CSRF token
 */
export async function proxmoxConnect(
  credentials: ProxmoxCredentials
): Promise<ProxmoxSession> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    // Simulate connection delay
    await new Promise((resolve) => setTimeout(resolve, 1500));
    mockProxmoxSession = {
      server_url: credentials.server_url,
      ticket: "mock-ticket-" + Date.now(),
      csrf_token: "mock-csrf-" + Date.now(),
    };
    return mockProxmoxSession;
  }
  return invoke<ProxmoxSession>("proxmox_connect", { credentials });
}

/**
 * List available nodes on the Proxmox server.
 * @param session The authentication session
 * @returns List of available nodes
 */
export async function proxmoxListNodes(
  session: ProxmoxSession
): Promise<ProxmoxNode[]> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return [
      {
        name: "pve",
        status: "online",
        cpu_usage: 0.125,
        cpu_count: 16,
      },
      {
        name: "pve2",
        status: "online",
        cpu_usage: 0.082,
        cpu_count: 8,
      },
    ];
  }
  return invoke<ProxmoxNode[]>("proxmox_list_nodes", { session });
}

/** Server origins whose "local" storage accepts Import in the browser-only mock */
const mockImportServers = new Set<string>();

/**
 * List available storage on a Proxmox node.
 * @param session The authentication session
 * @param node The node name
 * @returns List of available storage locations
 */
export async function proxmoxListStorage(
  session: ProxmoxSession,
  node: string
): Promise<ProxmoxStorage[]> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return [
      {
        name: "local",
        storage_type: "dir",
        content: [
          "images",
          "rootdir",
          "vztmpl",
          "backup",
          "iso",
          "snippets",
          ...(mockImportServers.has(new URL(session.server_url).origin)
            ? ["import"]
            : []),
        ],
        available: 200 * 1024 * 1024 * 1024,
        active: true,
      },
      {
        name: "local-lvm",
        storage_type: "lvmthin",
        content: ["images", "rootdir"],
        available: 400 * 1024 * 1024 * 1024,
        active: true,
      },
    ];
  }
  return invoke<ProxmoxStorage[]>("proxmox_list_storage", { session, node });
}

/**
 * Enable Import on an active directory storage, keeping its other content
 * types. Only call this after the user agreed: the setting is cluster-wide
 * and stays enabled after installation.
 * @returns Whether this call changed the storage
 */
export async function proxmoxEnableStorageImport(
  session: ProxmoxSession,
  node: string,
  storage: string
): Promise<boolean> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    if (storage !== "local" || !["pve", "pve2"].includes(node)) {
      // Shaped like the native CommandError rejections
      throw {
        code: "proxmox_action_required",
        message: `Storage "${storage}" must be an active directory storage on node "${node}".`,
        retryable: false,
        details: {
          message_key: "backend.proxmox.storage_not_directory",
          message_params: { storage, node },
        },
      };
    }
    // Storage configuration is per cluster, not per spelling of its address
    const origin = new URL(session.server_url).origin;
    const changed = !mockImportServers.has(origin);
    mockImportServers.add(origin);
    return changed;
  }
  return invoke<boolean>("proxmox_enable_storage_import", {
    session,
    node,
    storage,
  });
}

/** List bridges and eligible SDN VNets on the selected node. */
export async function proxmoxListBridges(
  session: ProxmoxSession,
  node: string
): Promise<ProxmoxBridge[]> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return [
      {
        name: "vmbr0",
        network_type: "bridge",
        comments: null,
        vlan_aware: true,
      },
      {
        name: "vmbr1",
        network_type: "bridge",
        comments: "LAN",
        vlan_aware: false,
      },
    ];
  }
  return invoke<ProxmoxBridge[]>("proxmox_list_bridges", { session, node });
}

/**
 * Get the next available VM ID on the Proxmox server.
 * @param session The authentication session
 * @returns Next available VM ID
 */
export async function proxmoxGetNextVmId(
  session: ProxmoxSession
): Promise<number> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return 100;
  }
  return invoke<number>("proxmox_get_next_vm_id", { session });
}

/**
 * Get the status of a Proxmox VM including its IP address if available.
 * @param session The authentication session
 * @param node Node the VM runs on
 * @param vmId The VM ID
 * @returns VM status and IP address
 */
export async function proxmoxGetVmStatus(
  session: ProxmoxSession,
  node: string,
  vmId: number
): Promise<VmStatusInfo> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return {
      status: "running",
      ip_address: "192.168.1.150",
    };
  }
  return invoke<VmStatusInfo>("proxmox_get_vm_status", {
    session,
    node,
    vmId,
  });
}

/** Run the checks `proxmoxCreateVm` starts with, without creating anything. */
export async function proxmoxCheckVmConfig(
  session: ProxmoxSession,
  config: ProxmoxVmConfig
): Promise<void> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return;
  }
  return invoke<void>("proxmox_check_vm_config", { session, config });
}

/**
 * Create and start a Home Assistant VM on Proxmox.
 * @param session The authentication session
 * @param config VM configuration
 * @param onProgress Callback for progress updates
 * @param attempt Names this install, so `cancelVmInstall` can never stop another
 * @returns Result with VM ID and node
 */
export async function proxmoxCreateVm(
  session: ProxmoxSession,
  config: ProxmoxVmConfig,
  onProgress: (progress: FlashProgress) => void,
  attempt: string
): Promise<ProxmoxVmResult> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return simulateProxmoxInstall(config, onProgress, attempt);
  }

  const channel = new Channel<FlashProgress>();
  channel.onmessage = (progress) => {
    onProgress(progress);
  };

  return invoke<ProxmoxVmResult>("proxmox_create_vm", {
    session,
    config,
    attempt,
    progressChannel: channel,
  });
}

/**
 * Simulate Proxmox VM installation for browser-only mode
 */
async function simulateProxmoxInstall(
  config: ProxmoxVmConfig,
  onProgress: (progress: FlashProgress) => void,
  attempt: string
): Promise<ProxmoxVmResult> {
  const compressedSize = 400 * 1024 * 1024; // 400 MB compressed
  const extractedSize = 1200 * 1024 * 1024; // 1.2 GB qcow2

  // Byte counts like the backend's: the download and extraction measure the
  // compressed image, the upload the extracted one, VM steps have none
  const stages: Array<{
    stage: FlashProgress["stage"];
    totalBytes: number;
    steps: number;
    delay: number;
  }> = [
    {
      stage: "downloading",
      totalBytes: compressedSize,
      steps: 40,
      delay: 100,
    },
    {
      stage: "extracting",
      totalBytes: compressedSize,
      steps: 10,
      delay: 80,
    },
    {
      stage: "uploading",
      totalBytes: extractedSize,
      steps: 20,
      delay: 80,
    },
    {
      stage: "creating_vm",
      totalBytes: 0,
      steps: 15,
      delay: 100,
    },
    {
      stage: "starting_vm",
      totalBytes: 0,
      steps: 10,
      delay: 150,
    },
  ];

  mockVmAttempt = attempt;
  mockVmCancelled = false;

  for (const { stage, totalBytes, steps, delay } of stages) {
    for (let step = 0; step <= steps; step++) {
      // Like the native install, a stop counts until the VM is being created
      if (stage !== "starting_vm" && (stage !== "creating_vm" || step === 0)) {
        throwIfMockVmCancelled();
      }
      // Each stage counts from 0 to 100 on its own, like the backend
      const stageProgress = (step * 100) / steps;

      onProgress({
        stage,
        // The backend spends 5-95% of the upload on sending the bytes
        progress: Math.round(
          stage === "uploading" ? 5 + stageProgress * 0.9 : stageProgress
        ),
        bytes_processed: Math.round((totalBytes * stageProgress) / 100),
        total_bytes: totalBytes,
        message: "",
      });

      if (stage === "downloading" && step === steps / 2) {
        failMockOperation("proxmox-download");
      }
      if (stage === "creating_vm" && step === 0) failMockOperation("proxmox");

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    // The last step left every byte sent at 95%, while Proxmox processes
    // the upload; only then does the backend report 100%
    if (stage === "uploading") {
      await new Promise((resolve) => setTimeout(resolve, delay * 5));
      throwIfMockVmCancelled();
      onProgress({
        stage,
        progress: 100,
        bytes_processed: totalBytes,
        total_bytes: totalBytes,
        message: "",
      });
    }
  }

  return {
    vm_id: config.vm_id,
    node: config.node,
  };
}
