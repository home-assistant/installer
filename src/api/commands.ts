import { formatNumber, localize } from "../localization/localize.js";
import { invoke, Channel } from "@tauri-apps/api/core";
import { failMockOperation } from "./mock-failures.js";
import type {
  BlockDevice,
  DeviceManifest,
  FlashProgress,
  FlashRequest,
  FlashResult,
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

function isBrowserOnly(): boolean {
  return typeof window !== "undefined" && !("__TAURI__" in window);
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
 */
export async function flashImage(
  request: FlashRequest,
  onProgress: (progress: FlashProgress) => void
): Promise<FlashResult> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    // Simulate flash progress in browser-only mode
    return simulateFlashProgress(onProgress);
  }

  const channel = new Channel<FlashProgress>();

  channel.onmessage = (progress) => {
    onProgress(progress);
  };

  return invoke<FlashResult>("flash_image", {
    request,
    progressChannel: channel,
  });
}

/**
 * Simulate flash progress for browser-only mode
 */
async function simulateFlashProgress(
  onProgress: (progress: FlashProgress) => void
): Promise<FlashResult> {
  const compressedSize = 400 * 1024 * 1024; // 400 MB compressed
  const extractedSize = 2 * 1024 * 1024 * 1024; // 2 GB extracted

  const stages: Array<{
    stage: FlashProgress["stage"];
    message: string;
    weight: number;
    totalBytes: number;
    showBytes: boolean;
    steps: number;
    delay: number;
  }> = [
    {
      stage: "downloading",
      message: localize("api.commands.downloading_image"),
      weight: 30,
      totalBytes: compressedSize,
      showBytes: true,
      steps: 30,
      delay: 150,
    },
    {
      stage: "extracting",
      message: localize("api.commands.extracting_image"),
      weight: 10,
      totalBytes: 0,
      showBytes: false,
      steps: 10,
      delay: 100,
    },
    {
      stage: "writing",
      message: localize("api.commands.writing_to_device"),
      weight: 35,
      totalBytes: extractedSize,
      showBytes: true,
      steps: 35,
      delay: 175,
    },
    {
      stage: "verifying",
      message: localize("api.commands.verifying_written_data"),
      weight: 15,
      totalBytes: extractedSize,
      showBytes: true,
      steps: 15,
      delay: 150,
    },
    {
      stage: "finalizing",
      message: localize("api.commands.finalizing"),
      weight: 10,
      totalBytes: 0,
      showBytes: false,
      steps: 10,
      delay: 100,
    },
  ];

  let overallProgress = 0;

  for (const {
    stage,
    message,
    weight,
    totalBytes,
    showBytes,
    steps,
    delay,
  } of stages) {
    for (let step = 0; step <= steps; step++) {
      const stageProgress = (step * 100) / steps;
      const progress = overallProgress + (stageProgress * weight) / 100;

      onProgress({
        stage,
        progress: Math.round(progress),
        bytes_processed: showBytes
          ? Math.round((totalBytes * stageProgress) / 100)
          : 0,
        total_bytes: showBytes ? totalBytes : 0,
        message,
      });

      if (stage === "writing" && step === 0) failMockOperation("flash");

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    overallProgress += weight;
  }

  onProgress({
    stage: "complete",
    progress: 100,
    bytes_processed: extractedSize,
    total_bytes: extractedSize,
    message: localize("api.commands.installation_complete"),
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
 * Format bytes using decimal units, matching storage manufacturers.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0)
    return localize("views.sbc.confirmation_view.unknown_size");
  if (bytes === 0) return localize("api.commands.0_b");

  const k = 1000;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.max(
    0,
    Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
  );

  // Do not round a drive just below a capacity threshold up to that threshold.
  const value = Math.floor((bytes / Math.pow(k, i)) * 10) / 10;
  // Grouping would turn the oversized "1000 TB" clamp into "1,000 TB".
  return localize("format.bytes", {
    amount: formatNumber(value, { useGrouping: false }),
    unit: sizes[i],
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

/** Release a temporary image which was not consumed by VM creation. */
export async function discardUtmImage(imagePath: string): Promise<void> {
  if (MOCK_ALLOWED && isBrowserOnly()) return;
  await invoke("discard_utm_image", { imagePath });
}

/**
 * Download the HAOS qcow2 image for UTM.
 * @param onProgress Callback for progress updates
 * @returns Path to the downloaded qcow2 file
 */
export async function downloadUtmImage(
  onProgress: (progress: FlashProgress) => void
): Promise<string> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    // Simulate download progress in browser-only mode
    return simulateUtmDownload(onProgress);
  }

  const channel = new Channel<FlashProgress>();

  channel.onmessage = (progress) => {
    onProgress(progress);
  };

  return invoke<string>("download_utm_image", {
    progressChannel: channel,
  });
}

/**
 * Simulate UTM download for browser-only mode
 */
async function simulateUtmDownload(
  onProgress: (progress: FlashProgress) => void
): Promise<string> {
  const stages: Array<{
    stage: FlashProgress["stage"];
    message: string;
    steps: number;
    delay: number;
  }> = [
    {
      stage: "downloading",
      message: localize("api.commands.downloading_haos_image"),
      steps: 20,
      delay: 100,
    },
    {
      stage: "extracting",
      message: localize("api.commands.extracting_image"),
      steps: 10,
      delay: 100,
    },
  ];

  let overallProgress = 0;
  const stageWeight = 100 / stages.length;

  for (const { stage, message, steps, delay } of stages) {
    for (let step = 0; step <= steps; step++) {
      const stageProgress = (step * 100) / steps;
      const progress = overallProgress + (stageProgress * stageWeight) / 100;

      onProgress({
        stage,
        progress: Math.round(progress),
        bytes_processed: 0,
        total_bytes: 0,
        message,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    overallProgress += stageWeight;
  }

  onProgress({
    stage: "complete",
    progress: 100,
    bytes_processed: 0,
    total_bytes: 0,
    message: localize("api.commands.download_complete"),
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
 * Resize a UTM VM's disk before first start.
 * @param vmId The VM ID
 * @param sizeGb The target disk size in GB
 */
export async function resizeUtmVmDisk(
  vmId: string,
  sizeGb: number
): Promise<void> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return;
  }
  return invoke<void>("resize_utm_vm_disk", { vmId, sizeGb });
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
        cpu_usage: 12.5,
        memory_used: 8 * 1024 * 1024 * 1024,
        memory_total: 32 * 1024 * 1024 * 1024,
      },
      {
        name: "pve2",
        status: "online",
        cpu_usage: 8.2,
        memory_used: 4 * 1024 * 1024 * 1024,
        memory_total: 16 * 1024 * 1024 * 1024,
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
        total: 500 * 1024 * 1024 * 1024,
        active: true,
      },
      {
        name: "local-lvm",
        storage_type: "lvmthin",
        content: ["images", "rootdir"],
        available: 400 * 1024 * 1024 * 1024,
        total: 1024 * 1024 * 1024 * 1024,
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
        message: `Storage '${storage}' must be an active directory storage on node '${node}'.`,
        retryable: false,
        details: {},
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

/**
 * Create and start a Home Assistant VM on Proxmox.
 * @param session The authentication session
 * @param config VM configuration
 * @param onProgress Callback for progress updates
 * @returns Result with VM ID and node
 */
export async function proxmoxCreateVm(
  session: ProxmoxSession,
  config: ProxmoxVmConfig,
  onProgress: (progress: FlashProgress) => void
): Promise<ProxmoxVmResult> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    return simulateProxmoxInstall(config, onProgress);
  }

  const channel = new Channel<FlashProgress>();
  channel.onmessage = (progress) => {
    onProgress(progress);
  };

  return invoke<ProxmoxVmResult>("proxmox_create_vm", {
    session,
    config,
    progressChannel: channel,
  });
}

/**
 * Simulate Proxmox VM installation for browser-only mode
 */
async function simulateProxmoxInstall(
  config: ProxmoxVmConfig,
  onProgress: (progress: FlashProgress) => void
): Promise<ProxmoxVmResult> {
  const stages: Array<{
    stage: FlashProgress["stage"];
    message: string;
    weight: number;
    steps: number;
    delay: number;
  }> = [
    {
      stage: "downloading",
      message: localize("api.commands.downloading_haos_image"),
      weight: 40,
      steps: 40,
      delay: 100,
    },
    {
      stage: "extracting",
      message: localize("api.commands.extracting_image"),
      weight: 10,
      steps: 10,
      delay: 80,
    },
    {
      stage: "uploading",
      message: localize("api.commands.uploading_to_proxmox"),
      weight: 20,
      steps: 20,
      delay: 80,
    },
    {
      stage: "creating_vm",
      message: localize("api.commands.creating_virtual_machine"),
      weight: 15,
      steps: 15,
      delay: 100,
    },
    {
      stage: "starting_vm",
      message: localize("api.commands.starting_home_assistant_os"),
      weight: 15,
      steps: 10,
      delay: 150,
    },
  ];

  let overallProgress = 0;

  for (const { stage, message, weight, steps, delay } of stages) {
    for (let step = 0; step <= steps; step++) {
      const stageProgress = (step * 100) / steps;
      const progress = overallProgress + (stageProgress * weight) / 100;

      onProgress({
        stage,
        progress: Math.round(progress),
        bytes_processed: 0,
        total_bytes: 0,
        message,
      });

      if (stage === "creating_vm" && step === 0) failMockOperation("proxmox");

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    overallProgress += weight;
  }

  return {
    vm_id: config.vm_id,
    node: config.node,
  };
}
