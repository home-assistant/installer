import type { WifiConfig } from "../api/types.js";
import type { WizardSelections } from "../state/wizard-state.js";

/** Boards with built-in Wi-Fi that Home Assistant OS supports. */
const WIFI_BOARDS = new Set([
  "rpi3-64",
  "rpi4-64",
  "rpi5-64",
  "yellow",
  "generic-x86-64",
  "generic-aarch64",
]);

export function supportsWifi(board: string | undefined): boolean {
  return board !== undefined && WIFI_BOARDS.has(board);
}

/** The network to add, unless the selected board can't use one. */
export function selectedWifi(
  selections: WizardSelections
): WifiConfig | undefined {
  return supportsWifi(selections.deviceConfig?.board)
    ? selections.wifi
    : undefined;
}

// The rules below mirror haos_config::validate in hai-core.

/** Wi-Fi allows 32 bytes, fewer characters for accents and emoji. */
export function ssidTooLong(ssid: string): boolean {
  return new TextEncoder().encode(ssid).length > 32;
}

export function isValidSsid(ssid: string): boolean {
  return ssid.length > 0 && !ssidTooLong(ssid) && !/\p{Cc}/u.test(ssid);
}

export function isValidWifiPassword(password: string): boolean {
  return (
    /^[\x20-\x7e]{8,63}$/.test(password) || /^[0-9a-fA-F]{64}$/.test(password)
  );
}

export function isValidWifi(wifi: WifiConfig): boolean {
  return isValidSsid(wifi.ssid) && isValidWifiPassword(wifi.password);
}
