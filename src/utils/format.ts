import { formatNumber, localize } from "../localization/localize.js";

// A size keeps its fraction: 1.5 GB must not read as 2 GB
function formatSize(value: number): string {
  return formatNumber(value, { maximumFractionDigits: 20 });
}

/** A VM's memory in GB, as its slider shows it */
export function formatMemory(mb: number): string {
  return localize("components.drive_card.value_gb", {
    value0: formatSize(mb / 1024),
  });
}

/** A VM's memory in GB, as the confirm step lists it with the CPU cores */
export function formatRam(mb: number): string {
  return localize("views.proxmox.proxmox_confirm_view.value_gb_ram", {
    value0: formatSize(mb / 1024),
  });
}

/** A VM's disk in GB, or in TB from 1024 GB */
export function formatDiskSize(gb: number): string {
  return gb >= 1024
    ? localize("components.drive_card.value_tb", {
        value0: formatSize(gb / 1024),
      })
    : localize("components.drive_card.value_gb", {
        value0: formatSize(gb),
      });
}
