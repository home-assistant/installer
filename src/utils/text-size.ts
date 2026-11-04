import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { logFrontendError } from "./diagnostics.js";
import { getPlatform } from "./platform.js";

/**
 * The sizes on offer, as zoom factors of the whole window. The layout fits
 * the smallest window up to 200% (see breakpoints.ts).
 */
export const TEXT_SIZES = [1, 1.25, 1.5, 1.75, 2];

export const TEXT_SIZE_CHANGE = "text-size-change";

const STORAGE_KEY = "hai:text-size";

let current = 1;

export function textSize(): number {
  return current;
}

/** Zooms the window to one of `TEXT_SIZES` and remembers it for next time */
export function setTextSize(size: number): void {
  current = size;
  try {
    localStorage.setItem(STORAGE_KEY, String(size));
  } catch {
    // Not remembered, but still applied
  }
  window.dispatchEvent(new Event(TEXT_SIZE_CHANGE));
  if (isTauri()) {
    getCurrentWebview().setZoom(size).catch(logFrontendError);
  }
}

// Ctrl or Cmd with + and − step through the sizes, and 0 resets them, like
// a browser's zoom
function onKeyDown(event: KeyboardEvent): void {
  if (!(getPlatform() === "macos" ? event.metaKey : event.ctrlKey)) return;
  let index = TEXT_SIZES.indexOf(current);
  switch (event.key) {
    case "-":
      index--;
      break;
    case "=":
    case "+":
      index++;
      break;
    case "0":
      index = 0;
      break;
    default:
      return;
  }
  event.preventDefault();
  const next = TEXT_SIZES[index];
  if (next !== undefined && next !== current) setTextSize(next);
}

/** Restores the last size and takes over the zoom hotkeys */
export function initializeTextSize(): void {
  let stored = NaN;
  try {
    stored = Number(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Starts at 100%
  }
  if (TEXT_SIZES.includes(stored) && stored !== 1) setTextSize(stored);
  window.addEventListener("keydown", onKeyDown);
}
