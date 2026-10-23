/**
 * What Proxmox accepts for the VM the configure step sets up, and the
 * resources the step offers for it.
 */

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

export const CORE_OPTIONS = [2, 4, 6, 8, 10, 12, 16];
export const MEMORY_OPTIONS_MB = [
  2048, 4096, 6144, 8192, 12288, 16384, 24576, 32768,
];
export const DISK_SIZE_OPTIONS_GB = [32, 64, 128, 256, 512];

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

/**
 * The core counts to offer on a node with `cpus` CPUs. Proxmox creates a VM
 * with more cores than its node has, then won't start it.
 */
export function coreOptionsFor(cpus: number | null | undefined): number[] {
  if (!cpus) return CORE_OPTIONS;
  const fitting = CORE_OPTIONS.filter((cores) => cores <= cpus);
  return fitting.length ? fitting : [cpus];
}

/** Lower a chosen or restored core count to the options a node has. */
export function fitCores(cores: number, options: number[]): number {
  if (options.includes(cores)) return cores;
  return (
    options.filter((option) => option <= cores).pop() ?? options[0] ?? cores
  );
}
