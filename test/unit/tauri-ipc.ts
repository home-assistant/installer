import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { InstallerError } from "../../src/utils/installer-error.js";

type IpcHandler = (cmd: string, args: unknown) => unknown;

/** The JSON rejection value sent by a Tauri command, with no Error prototype. */
export function ipcError(
  code: string,
  message: string,
  retryable = false,
  details: Record<string, unknown> = {}
): InstallerError {
  return { code, message, retryable, details };
}

/**
 * Route `src/api/commands.ts` through a Tauri IPC mock instead of its
 * browser-only simulation, so a test controls exactly when (and how) each
 * backend call settles.
 *
 * Commands not handled by `handler` reject, so an unexpected call fails loudly.
 * With `mockEvents`, `emit` from `@tauri-apps/api/event` reaches listeners.
 * Undo with `restoreTauriIpc()`.
 */
export function mockTauriIpc(
  handler: IpcHandler,
  {
    includeLogs = false,
    mockEvents = false,
  }: { includeLogs?: boolean; mockEvents?: boolean } = {}
): void {
  // `commands.ts` only goes through IPC when it detects Tauri
  (window as unknown as { isTauri?: boolean }).isTauri = true;
  mockIPC(
    (cmd, args) => {
      // Diagnostics log every view's progress; only tests about logging see it
      if (cmd === "log_frontend_event" && !includeLogs) return undefined;
      return handler(cmd, args);
    },
    { shouldMockEvents: mockEvents }
  );
}

export function restoreTauriIpc(): void {
  clearMocks();
  delete (window as unknown as { isTauri?: boolean }).isTauri;
}

/** A promise plus the functions that settle it, for holding a call open. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let pending promise chains (and the views awaiting them) run to the end. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
