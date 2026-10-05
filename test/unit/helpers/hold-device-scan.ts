import type { BlockDevice } from "../../../src/api/types.js";

/**
 * Make device scans hang until the test settles them, by standing in for the
 * Tauri bridge. Call `restore()` when done; until then every backend call
 * returns the same pending scan.
 */
export function holdDeviceScan() {
  let resolve!: (devices: BlockDevice[]) => void;
  let reject!: (error: Error) => void;
  const scan = new Promise<BlockDevice[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const w = window as unknown as Record<string, unknown>;
  w.__TAURI__ = {};
  w.__TAURI_INTERNALS__ = { invoke: () => scan };

  return {
    resolve,
    reject,
    restore() {
      delete w.__TAURI__;
      delete w.__TAURI_INTERNALS__;
    },
  };
}

/** Let a settled scan's continuations run. */
export const flush = () => new Promise((r) => setTimeout(r, 0));
