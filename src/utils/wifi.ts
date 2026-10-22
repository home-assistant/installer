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

export type SsidProblem = "missing" | "too_long" | "control_characters";

/** What's wrong with a network name, if anything. */
export function ssidProblem(ssid: string): SsidProblem | undefined {
  if (!ssid) return "missing";
  // Wi-Fi allows 32 bytes, fewer characters for accents and emoji
  if (new TextEncoder().encode(ssid).length > 32) return "too_long";
  if (/\p{Cc}/u.test(ssid)) return "control_characters";
  return undefined;
}

export type WifiPasswordProblem = "too_short" | "too_long" | "characters";

/** What's wrong with a Wi-Fi password, if anything. */
export function wifiPasswordProblem(
  password: string
): WifiPasswordProblem | undefined {
  // A 64-digit hex key is used as is, instead of a passphrase
  if (/^[0-9a-fA-F]{64}$/.test(password)) return undefined;
  // A passphrase is printable ASCII only
  if (/[^\x20-\x7e]/.test(password)) return "characters";
  if (password.length > 63) return "too_long";
  if (password.length < 8) return "too_short";
  return undefined;
}

export function isValidWifi(wifi: WifiConfig): boolean {
  return !ssidProblem(wifi.ssid) && !wifiPasswordProblem(wifi.password);
}
