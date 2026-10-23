import { formatNumber, localize } from "../localization/localize.js";

// A size keeps its fraction: 1.5 GB must not read as 2 GB
function formatSize(value: number, unit: "gigabyte" | "terabyte"): string {
  return formatNumber(value, {
    style: "unit",
    unit,
    maximumFractionDigits: 20,
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
  return gb >= 1024
    ? formatSize(gb / 1024, "terabyte")
    : formatSize(gb, "gigabyte");
}
