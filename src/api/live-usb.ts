import { invoke, Channel } from "@tauri-apps/api/core";
import { failMockOperation } from "./mock-failures.js";
import type { ExpectedDevice, FlashProgress } from "./types.js";

/** Same rule as commands.ts: browser-only mocks exist in development builds only. */
const MOCK_ALLOWED = import.meta.env.DEV;

function isBrowserOnly(): boolean {
  return typeof window !== "undefined" && !("isTauri" in window);
}

/** What the live USB flow needs before it can start. */
export interface LiveUsbStatus {
  /** The program for the stick (hai-live) was found. */
  hai_live_found: boolean;
  /** Writing a stick needs the app restarted as administrator (Windows only). */
  needs_admin: boolean;
}

export async function getLiveUsbStatus(): Promise<LiveUsbStatus> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    // Browser tests pick a screen through this session value.
    const scenario = sessionStorage.getItem("hai:mock-live-usb");
    return {
      hai_live_found: scenario !== "hai-live-missing",
      needs_admin: scenario === "needs-admin",
    };
  }
  return invoke<LiveUsbStatus>("live_usb_status");
}

/**
 * Build the bootable stick and write it to `deviceId`, with verification.
 * `attempt` names this run, so `cancelLiveUsb` can never stop another.
 */
export async function createLiveUsb(
  deviceId: string,
  expectedDevice: ExpectedDevice,
  onProgress: (progress: FlashProgress) => void,
  attempt: string
): Promise<void> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    await simulate(
      ["downloading", "extracting", "writing", "verifying"],
      onProgress,
      attempt
    );
    return;
  }
  const channel = new Channel<FlashProgress>();
  channel.onmessage = onProgress;
  await invoke("create_live_usb", {
    deviceId,
    expectedDevice,
    attempt,
    progressChannel: channel,
  });
}

/** Build the ISO and save it as `folder/fileName`. Resolves to the saved path. */
export async function saveLiveIso(
  folder: string,
  fileName: string,
  overwrite: boolean,
  onProgress: (progress: FlashProgress) => void,
  attempt: string
): Promise<string> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    await simulate(["downloading", "extracting"], onProgress, attempt);
    return `${folder}/${fileName}`;
  }
  const channel = new Channel<FlashProgress>();
  channel.onmessage = onProgress;
  return invoke<string>("save_live_iso", {
    folder,
    fileName,
    overwrite,
    attempt,
    progressChannel: channel,
  });
}

/** The simulated run in browser-only mode, and whether it was stopped. */
let mockAttempt: string | undefined;
let mockCancelled = false;

/**
 * Ask the stick or ISO run started as `attempt` to stop. It then rejects with
 * `cancelled`. The backend runs these like a flash, so this is `cancel_flash`.
 */
export async function cancelLiveUsb(attempt: string): Promise<void> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    if (attempt === mockAttempt) mockCancelled = true;
    return;
  }
  await invoke("cancel_flash", { attempt });
}

/** Checks the save location before anything is downloaded. */
export async function checkIsoLocation(
  folder: string,
  fileName: string
): Promise<{ exists: boolean }> {
  if (MOCK_ALLOWED && isBrowserOnly()) {
    // Same rule and message as the backend, so tests reach the error.
    if (/[\\/]/.test(fileName)) {
      throw {
        code: "invalid_file_name",
        message: "Enter a file name without folder separators.",
        retryable: false,
        details: {},
      };
    }
    // Lets browser tests reach the "replace it?" question.
    return { exists: fileName.startsWith("existing") };
  }
  return invoke<{ exists: boolean }>("check_iso_location", {
    folder,
    fileName,
  });
}

export async function revealInFolder(path: string): Promise<void> {
  if (MOCK_ALLOWED && isBrowserOnly()) return;
  await invoke("reveal_in_folder", { path });
}

/** Restart as administrator. The app closes if Windows grants it. */
export async function relaunchAsAdmin(): Promise<void> {
  if (MOCK_ALLOWED && isBrowserOnly()) return;
  await invoke("relaunch_as_admin");
}

export async function defaultIsoFolder(): Promise<string> {
  if (MOCK_ALLOWED && isBrowserOnly()) return "Downloads";
  // Loaded on use: a new import in the startup graph reloads Vite's dev server mid-test.
  const { downloadDir } = await import("@tauri-apps/api/path");
  return downloadDir();
}

/** The system folder picker. Resolves to null when cancelled. */
export async function chooseFolder(start: string): Promise<string | null> {
  if (MOCK_ALLOWED && isBrowserOnly()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const folder = await open({
    directory: true,
    defaultPath: start || undefined,
  });
  return typeof folder === "string" ? folder : null;
}

async function simulate(
  stages: FlashProgress["stage"][],
  onProgress: (progress: FlashProgress) => void,
  attempt: string
) {
  mockAttempt = attempt;
  mockCancelled = false;
  const total = 500_000_000;
  for (const stage of stages) {
    const measured = stage !== "extracting";
    for (let percent = 0; percent <= 100; percent += 20) {
      // Shaped like the native rejection
      if (mockCancelled) {
        throw {
          code: "cancelled",
          message: "Installation was cancelled.",
          retryable: true,
          details: {},
        };
      }
      onProgress({
        stage,
        progress: percent,
        bytes_processed: measured ? (total * percent) / 100 : 0,
        total_bytes: measured ? total : 0,
        message: "",
      });
      if (stage === "writing" && percent === 0) failMockOperation("flash");
      // Slow enough that browser tests can stop it halfway
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  onProgress({
    stage: "complete",
    progress: 100,
    bytes_processed: 0,
    total_bytes: 0,
    message: "",
  });
}
