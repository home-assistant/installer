import { localize } from "../../localization/localize.js";
import type { HaosConfig } from "../../api/types.js";

/** The compute modules a Yellow can have inside, each prepared differently. */
export type YellowModuleId = "yellow-cm4" | "yellow-cm5";

/** The Nabu Casa device, and for the Yellow the compute module in it. */
export type HaHardwareId = "green" | YellowModuleId | "blue";

export interface HaHardwareInstaller {
  /** Board the backend resolves to its pinned installer image. */
  board: "green-installer" | "yellow-installer";
  /** Release date of the pinned image, shown as its version. */
  released: Date;
}

/** Device id of the Yellow, whose compute module is picked on a step of its own. */
export const YELLOW_DEVICE_ID = "ha-yellow";

export interface HaHardware {
  id: HaHardwareId;
  /** Device id in the wizard selections; both Yellows share one. */
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
  // A calendar date, not an instant: local midnight shows this day in every
  // time zone, where a fixed UTC time moves a day in some of them.
  released: new Date(2024, 3, 10),
};

const YELLOW_INSTALLER: HaHardwareInstaller = {
  board: "yellow-installer",
  released: new Date(2023, 9, 25),
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
    deviceId: YELLOW_DEVICE_ID,
    image: "/assets/devices/homeassistant_yellow.png",
    installer: YELLOW_INSTALLER,
  },
  {
    // The pinned Yellow installer only boots on a CM4. On a CM5, rpiboot
    // exposes the eMMC itself, so Home Assistant OS is written to it directly.
    id: "yellow-cm5",
    deviceId: YELLOW_DEVICE_ID,
    image: "/assets/devices/homeassistant_yellow.png",
    manifestBoard: "yellow",
  },
  {
    // The Blue is an ODROID-N2+ in a Home Assistant case.
    id: "blue",
    deviceId: "ha-blue",
    image: "/assets/devices/homeassistant_blue.png",
    manifestBoard: "odroid-n2",
  },
];

export function findHaHardware(id: unknown): HaHardware | undefined {
  return HA_HARDWARE.find((hardware) => hardware.id === id);
}

export function isYellow(id: HaHardwareId | undefined): id is YellowModuleId {
  return findHaHardware(id)?.deviceId === YELLOW_DEVICE_ID;
}

/** Name on the device step, where the Yellow has no compute module yet. */
export function haDeviceName(hardware: HaHardware): string {
  return hardware.deviceId === YELLOW_DEVICE_ID
    ? localize("views.ha_hardware.hardware.yellow")
    : haHardwareName(hardware.id);
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
