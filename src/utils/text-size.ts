import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { logFrontendError } from "./diagnostics.js";
import { getPlatform } from "./platform.js";

/**
 * The sizes on offer, as zoom factors of the whole window, in steps of 20%.
 * The layout fits the smallest window up to 200% (see breakpoints.ts).
 */
export const TEXT_SIZES = [1, 1.2, 1.4, 1.6, 1.8, 2];

export const TEXT_SIZE_CHANGE = "text-size-change";

const STORAGE_KEY = "hai:text-size";

let current = 1;

export function textSize(): number {
  return current;
}

/** How far the window is zoomed: a browser leaves that to its own controls */
export function windowZoom(): number {
  return isTauri() ? current : 1;
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

/** Steps `by` sizes up or down, and stays put at either end */
export function stepTextSize(by: number): void {
  const next = TEXT_SIZES[TEXT_SIZES.indexOf(current) + by];
  if (next !== undefined) setTextSize(next);
}

// Ctrl or Cmd with + and − step through the sizes, and 0 resets them, like
// a browser's zoom
function onKeyDown(event: KeyboardEvent): void {
  if (!(getPlatform() === "macos" ? event.metaKey : event.ctrlKey)) return;
  // AltGr reports Ctrl and Alt on Windows, and types characters such as "@"
  if (event.altKey) return;
  // The top-row 0 key types "à" on AZERTY, so match it by position too
  switch (event.code === "Digit0" ? "0" : event.key) {
    case "-":
      stepTextSize(-1);
      break;
    case "=":
    case "+":
      stepTextSize(1);
      break;
    case "0":
      if (current !== TEXT_SIZES[0]) setTextSize(TEXT_SIZES[0]);
      break;
    default:
      return;
  }
  event.preventDefault();
}

/** How far the wheel turns for one step: a notch, or a touchpad's swipe */
const WHEEL_STEP = 50;

let wheeled = 0;

// Ctrl with the mouse wheel, or a pinch on a touchpad, zooms like a browser.
// A touchpad sends many small turns, which add up to a step.
function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return;
  event.preventDefault();
  if (Math.sign(event.deltaY) !== Math.sign(wheeled)) wheeled = 0;
  wheeled += event.deltaY;
  if (Math.abs(wheeled) < WHEEL_STEP) return;
  stepTextSize(wheeled < 0 ? 1 : -1);
  wheeled = 0;
}

/** Restores the last size and takes over the zoom keys and wheel */
export function initializeTextSize(): void {
  let stored = NaN;
  try {
    stored = Number(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Starts at 100%
  }
  if (TEXT_SIZES.includes(stored) && stored !== 1) setTextSize(stored);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("wheel", onWheel, { passive: false });
}
