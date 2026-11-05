import { formatNumber, localize } from "../localization/localize.js";

/**
 * The bytes in a VM's GB. Proxmox and UTM make a "32G" disk 32 GiB, and the
 * sliders call that 32 GB, so free space for a disk counts the same way.
 */
const VM_GB_BYTES = 1024 ** 3;

// A size keeps its fraction: 1.5 GB must not read as 2 GB
function formatSize(value: number, unit: "gigabyte" | "terabyte"): string {
  return formatNumber(value, {
    style: "unit",
    unit,
    maximumFractionDigits: 20,
  });
}

/** A size in GB, or in TB from 1024 GB, with its number rounded by `round` */
function formatGb(gb: number, round = (size: number) => size): string {
  return gb >= 1024
    ? formatSize(round(gb / 1024), "terabyte")
    : formatSize(round(gb), "gigabyte");
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

/** A VM's memory in GB, as its slider shows it */
export function formatMemory(mb: number): string {
  return formatSize(mb / 1024, "gigabyte");
}

/** A VM's memory in GB, as the confirm step lists it with the CPU cores */
export function formatRam(mb: number): string {
  return localize("common.vm.memory", { size: formatMemory(mb) });
}

/** A VM's disk in GB, or in TB from 1024 GB */
export function formatDiskSize(gb: number): string {
  return formatGb(gb);
}

/**
 * Free space for a VM disk, in the GB its size is chosen in, so the two
 * compare. Rounded down to a tenth: 31.99 GB must not read as room for 32 GB.
 */
export function formatFreeSpace(bytes: number): string {
  return formatGb(bytes / VM_GB_BYTES, (size) => Math.floor(size * 10) / 10);
}
