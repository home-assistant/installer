import { localize } from "../../localization/localize.js";
import type { HaosConfig } from "../../api/types.js";

/** The Nabu Casa device, and for the Yellow the compute module in it. */
export type HaHardwareId = "green" | "yellow-cm4" | "yellow-cm5" | "blue";

export interface HaHardwareInstaller {
  /** Board the backend resolves to its pinned installer image. */
  board: "green-installer" | "yellow-installer";
  downloadUrl: string;
  /** Release date of the pinned image, shown as its version. */
  released: Date;
}

export interface HaHardware {
  id: HaHardwareId;
  /** Device id in the wizard selections. */
  deviceId: string;
  image: string;
  /** Pinned installer; without one, the latest HAOS for `manifestBoard`. */
  installer?: HaHardwareInstaller;
  /** Manifest board whose storage requirements and release apply. */
  manifestBoard?: string;
}

/**
 * Mirrors the pinned images in hai-core's hardware_installer.rs, which owns
 * the download, digest and storage checks. Keep both in sync.
 */
const GREEN_INSTALLER: HaHardwareInstaller = {
  board: "green-installer",
  downloadUrl:
    "https://github.com/NabuCasa/buildroot-installer/releases/download/green-installer-20240410/green-installer-20240410.img.xz",
  // Noon UTC, so no time zone shows it as the day before.
  released: new Date(Date.UTC(2024, 3, 10, 12)),
};

const YELLOW_INSTALLER: HaHardwareInstaller = {
  board: "yellow-installer",
  downloadUrl:
    "https://github.com/NabuCasa/buildroot-installer/releases/download/yellow-installer-20231025/yellow-installer-20231025.img.xz",
  released: new Date(Date.UTC(2023, 9, 25, 12)),
};

/** The installers only have to fit on the drive; see hardware_installer.rs. */
const INSTALLER_STORAGE_BYTES = 1_000_000_000;

export const HA_HARDWARE: readonly HaHardware[] = [
  {
    id: "green",
    deviceId: "ha-green",
    image: "/assets/devices/homeassistant_green.png",
    installer: GREEN_INSTALLER,
  },
  {
    id: "yellow-cm4",
    deviceId: "ha-yellow-cm4",
    image: "/assets/devices/homeassistant_yellow.png",
    installer: YELLOW_INSTALLER,
  },
  {
    id: "yellow-cm5",
    deviceId: "ha-yellow-cm5",
    image: "/assets/devices/homeassistant_yellow.png",
    installer: YELLOW_INSTALLER,
  },
  {
    // The Blue is an ODROID-N2+ in a Home Assistant case.
    id: "blue",
    deviceId: "ha-blue",
    image: "/assets/devices/hardkernel_odroid-n2.png",
    manifestBoard: "odroid-n2",
  },
];

export function findHaHardware(id: unknown): HaHardware | undefined {
  return HA_HARDWARE.find((hardware) => hardware.id === id);
}

export function haHardwareName(id: HaHardwareId): string {
  switch (id) {
    case "green":
      return localize("views.ha_hardware.hardware.green");
    case "yellow-cm4":
      return localize("views.ha_hardware.hardware.yellow_cm4");
    case "yellow-cm5":
      return localize("views.ha_hardware.hardware.yellow_cm5");
    case "blue":
      return localize("views.ha_hardware.hardware.blue");
  }
}

/** Storage requirements for writing a pinned installer. */
export function installerConfig(installer: HaHardwareInstaller): HaosConfig {
  return {
    board: installer.board,
    download_url: installer.downloadUrl,
    minimum_storage_bytes: INSTALLER_STORAGE_BYTES,
    recommended_storage_bytes: INSTALLER_STORAGE_BYTES,
  };
}

/** The installer behind a board, if the board is an installer board. */
export function findInstaller(
  board: string | undefined
): HaHardwareInstaller | undefined {
  return [GREEN_INSTALLER, YELLOW_INSTALLER].find(
    (installer) => installer.board === board
  );
}

/** Installer name with its release date, standing in for a HAOS version. */
export function installerName(installer: HaHardwareInstaller): string {
  return installer.board === "green-installer"
    ? localize("views.ha_hardware.hardware.green_installer", {
        released: installer.released,
      })
    : localize("views.ha_hardware.hardware.yellow_installer", {
        released: installer.released,
      });
}
