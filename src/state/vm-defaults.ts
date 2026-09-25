/**
 * Defaults for the VM configuration collected in the UTM and Proxmox flows.
 *
 * The configure step seeds its form from these, and the install step falls
 * back to them, so both have to agree: a mismatch is how a user ends up
 * installing something other than what the confirm step showed them.
 */

export const DEFAULT_CPU_CORES = 4;
export const DEFAULT_MEMORY_MB = 4096;
export const DEFAULT_DISK_SIZE_GB = 32;

/** UTM shows the name in its virtual machine list, so spaces are fine. */
export const DEFAULT_UTM_VM_NAME = "Home Assistant";

/** Proxmox names must be hostname-safe (alphanumeric, dash, underscore, dot). */
export const DEFAULT_PROXMOX_VM_NAME = "home-assistant";
export const DEFAULT_PROXMOX_VM_ID = 100;
export const DEFAULT_PROXMOX_NODE = "pve";
export const DEFAULT_PROXMOX_STORAGE = "local";
