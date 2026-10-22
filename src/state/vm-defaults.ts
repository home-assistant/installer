/**
 * Defaults for the VM configuration collected in the UTM and Proxmox flows.
 *
 * The configure step seeds its form from these, and the install step falls
 * back to them, so both have to agree: a mismatch is how a user ends up
 * installing something other than what the confirm step showed them.
 */

import type { ProxmoxVmConfig } from "../api/types.js";
import type { WizardSelections } from "./wizard-state.js";

export const DEFAULT_CPU_CORES = 4;
export const DEFAULT_MEMORY_MB = 4096;
export const DEFAULT_DISK_SIZE_GB = 32;

/** UTM shows the name in its virtual machine list, so spaces are fine. */
export const DEFAULT_UTM_VM_NAME = "Home Assistant";

/** Whether UTM can be given this name. The view and the Next check share it. */
export function isValidUtmVmName(name: string): boolean {
  return name.trim() !== "";
}

/** Proxmox names must be hostname-safe (alphanumeric, dash, underscore, dot). */
export const DEFAULT_PROXMOX_VM_NAME = "home-assistant";
export const DEFAULT_PROXMOX_VM_ID = 100;
export const DEFAULT_PROXMOX_NODE = "pve";
export const DEFAULT_PROXMOX_STORAGE = "local";

/** The VM a Proxmox install creates, so its checks and the install agree. */
export function proxmoxVmConfig(selections: WizardSelections): ProxmoxVmConfig {
  return {
    node: selections.proxmoxNode || DEFAULT_PROXMOX_NODE,
    storage: selections.proxmoxStorage || DEFAULT_PROXMOX_STORAGE,
    bridge: selections.proxmoxBridge ?? "",
    vlan_tag: selections.proxmoxVlanTag,
    vm_id: selections.proxmoxVmId ?? DEFAULT_PROXMOX_VM_ID,
    name: selections.vmName || DEFAULT_PROXMOX_VM_NAME,
    cpu_cores: selections.cpuCores ?? DEFAULT_CPU_CORES,
    memory_mb: selections.memoryMb ?? DEFAULT_MEMORY_MB,
    disk_size_gb: selections.diskSizeGb ?? DEFAULT_DISK_SIZE_GB,
  };
}
