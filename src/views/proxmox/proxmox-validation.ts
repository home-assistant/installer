/**
 * What Proxmox accepts for the VM the configure step sets up, and the
 * resources the step offers for it.
 */

import { memoryOptionsUpTo } from "../../state/vm-defaults.js";
import type { InstallerError } from "../../utils/installer-error.js";

/**
 * Proxmox's `dns-name` format: dot-separated labels of letters, digits and
 * dashes, each starting and ending with a letter or digit. Proxmox only
 * checks it when it creates the VM, after the download and the upload.
 */
const VM_NAME_LABEL = "[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?";
export const VM_NAME_PATTERN = new RegExp(
  `^${VM_NAME_LABEL}(\\.${VM_NAME_LABEL})*$`
);

/** The VM IDs Proxmox accepts */
export const MIN_VM_ID = 100;
export const MAX_VM_ID = 999_999_999;

/** The VLAN tags Proxmox accepts */
export const MIN_VLAN_TAG = 1;
export const MAX_VLAN_TAG = 4094;

/** A setting on the configure step that the check at Next can refuse */
export type CheckedSetting = "name" | "storage" | "vmId";

/**
 * What each refusal of the check at Next is about, by its backend message.
 * The others, like missing permissions, are no one setting's.
 */
const CHECKED_SETTINGS = new Map<string, CheckedSetting>([
  ["backend.proxmox.invalid_vm_name", "name"],
  ["backend.proxmox.storage_not_found", "storage"],
  ["backend.proxmox.storage_inactive", "storage"],
  ["backend.proxmox.storage_no_disk_images", "storage"],
  // A smaller disk fits too, but the message names the storage
  ["backend.proxmox.storage_too_small", "storage"],
  ["backend.proxmox.vm_id_unavailable", "vmId"],
]);

/** The setting a refusal of the check at Next is about, if it is one's */
export function checkedSetting(
  error: InstallerError
): CheckedSetting | undefined {
  const key = error.details.message_key;
  return typeof key === "string" ? CHECKED_SETTINGS.get(key) : undefined;
}

/**
 * Refusals another choice on the configure step fixes, besides the checked
 * settings: the node, the bridge, the disk size and the Import storage.
 * An install repeats the check before it makes the VM, and may get these
 * from a server that changed since.
 */
const CONFIGURE_REFUSALS = new Set([
  ...CHECKED_SETTINGS.keys(),
  "backend.proxmox.node_not_found",
  "backend.proxmox.node_offline",
  "backend.proxmox.too_many_cores",
  "backend.proxmox.bridge_unavailable",
  "backend.proxmox.bridge_not_vlan_aware",
  "backend.proxmox.disk_too_small",
  "backend.proxmox.no_import_storage",
  "backend.proxmox.import_storage_too_small",
]);

/**
 * The key of the refusal in `error`. One that left the uploaded image behind
 * comes inside a message that names the image, and is still that refusal.
 */
function refusalKey(error: InstallerError): string | undefined {
  const { message_key: key, message_params: params } = error.details;
  if (key === "backend.proxmox.image_left_behind") {
    const reason = (params as { reason?: { key?: unknown } } | undefined)
      ?.reason?.key;
    return typeof reason === "string" ? reason : undefined;
  }
  return typeof key === "string" ? key : undefined;
}

/** Whether another choice on the configure step can fix `error` */
export function fixedOnConfigure(error: InstallerError): boolean {
  const key = refusalKey(error);
  return key !== undefined && CONFIGURE_REFUSALS.has(key);
}

/**
 * Refusals of the bridge check the install makes once more right before it
 * asks Proxmox for the VM, after it already says the VM is being created.
 * Nothing was sent, so no VM exists.
 */
const REFUSED_BEFORE_CREATING = new Set([
  "backend.proxmox.bridge_unavailable",
  "backend.proxmox.bridge_not_vlan_aware",
]);

/** Whether `error` came before the VM was asked for, whatever the stage */
export function refusedBeforeCreating(error: InstallerError): boolean {
  const key = refusalKey(error);
  return key !== undefined && REFUSED_BEFORE_CREATING.has(key);
}

export const CORE_OPTIONS = [2, 4, 6, 8, 10, 12, 16];
export const MEMORY_OPTIONS_MB = memoryOptionsUpTo(32768);

/** A whole number from min to max, or undefined */
export function parseWholeNumber(
  text: string,
  min: number,
  max: number
): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return value >= min && value <= max ? value : undefined;
}

/** Kept per CPU count, see `coreOptionsFor` */
const coreOptionsByCpus = new Map<number, number[]>();

/**
 * The core counts to offer on a node with `cpus` CPUs. Proxmox creates a VM
 * with more cores than its node has, then won't start it. The same count
 * gets the same array, so the sliders don't render again on every keystroke.
 */
export function coreOptionsFor(cpus: number | null | undefined): number[] {
  if (!cpus) return CORE_OPTIONS;
  let options = coreOptionsByCpus.get(cpus);
  if (!options) {
    const fitting = CORE_OPTIONS.filter((cores) => cores <= cpus);
    options = fitting.length ? fitting : [cpus];
    coreOptionsByCpus.set(cpus, options);
  }
  return options;
}

/** Lower a chosen or restored core count to the options a node has. */
export function fitCores(cores: number, options: number[]): number {
  if (options.includes(cores)) return cores;
  return (
    options.filter((option) => option <= cores).pop() ?? options[0] ?? cores
  );
}
