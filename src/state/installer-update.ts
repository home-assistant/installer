import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  restartAfterUpdate,
  type AvailableUpdate,
  type UpdateProgress,
} from "../api/index.js";
import {
  installerError,
  type InstallerError,
} from "../utils/installer-error.js";

/** How long a restart may take before the banner offers it again. */
export const RESTART_TIMEOUT_MS = 10_000;

export type InstallerUpdateState =
  | { status: "none" }
  | { status: "available"; update: AvailableUpdate }
  | {
      status: "downloading";
      update: AvailableUpdate;
      progress?: UpdateProgress;
    }
  | { status: "installing"; update: AvailableUpdate }
  | { status: "restarting"; update: AvailableUpdate }
  /**
   * Downloaded or installed, waiting for a restart; `blocked` while the
   * backend refused it for a running installation
   */
  | { status: "ready"; update: AvailableUpdate; blocked?: boolean }
  | { status: "failed"; update: AvailableUpdate; error: InstallerError };

type Listener = (state: InstallerUpdateState) => void;

/**
 * A newer version of the installer itself, checked for once per run: the
 * welcome screen, which offers it, comes back after every flow.
 *
 * The app only restarts while the welcome screen shows, so leaving it for a
 * flow while the update downloads never loses what was entered there; the
 * update then waits for the user to come back and restart.
 */
class InstallerUpdateStore {
  private _state: InstallerUpdateState = { status: "none" };
  private _check?: Promise<void>;
  /** Counts resets, so work started before one leaves the state alone. */
  private _generation = 0;
  private _visible = false;
  private _restartTimer?: number;
  private _listeners = new Set<Listener>();

  get state(): InstallerUpdateState {
    return this._state;
  }

  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Whether the banner, and so the welcome screen, shows. */
  setVisible(visible: boolean): void {
    this._visible = visible;
    // Back on the welcome screen, no installation runs anymore
    const state = this._state;
    if (visible && state.status === "ready" && state.blocked)
      this._set({ status: "ready", update: state.update });
  }

  /**
   * Look for an update, the first time only; later calls wait for that same
   * check. A failed check stays quiet.
   */
  check(): Promise<void> {
    this._check ??= this._runCheck(this._generation);
    return this._check;
  }

  private async _runCheck(generation: number) {
    try {
      const update = await checkForUpdate();
      if (update && generation === this._generation)
        this._set({ status: "available", update });
    } catch {
      // The backend logged why; the next run checks again
    }
  }

  /** Download and install the update, and restart into it. */
  async update(): Promise<void> {
    const state = this._state;
    if (state.status !== "available" && state.status !== "failed") return;
    const { update } = state;
    const generation = this._generation;
    const current = () => generation === this._generation;
    this._set({ status: "downloading", update });
    try {
      await downloadUpdate((progress) => {
        if (current() && this._state.status === "downloading") {
          this._set({ status: "downloading", update, progress });
        }
      });
    } catch (error) {
      if (current()) this._fail(update, error);
      return;
    }
    if (!current()) return;
    if (this._visible) await this._apply(update, generation);
    else this._set({ status: "ready", update });
  }

  /** Install the downloaded update, if it isn't yet, and restart into it. */
  async restart(): Promise<void> {
    const state = this._state;
    if (state.status !== "ready") return;
    await this._apply(state.update, this._generation);
  }

  private async _apply(update: AvailableUpdate, generation: number) {
    const current = () => generation === this._generation;
    this._set({ status: "installing", update });
    try {
      await installUpdate();
      if (!current()) return;
      // The install may have waited for a password while the user left
      if (!this._visible) {
        this._set({ status: "ready", update });
        return;
      }
      await restartAfterUpdate();
    } catch (error) {
      if (current()) this._fail(update, error);
      return;
    }
    if (!current()) return;
    this._set({ status: "restarting", update });
    // The app should be gone soon; if it's still here, offer the restart again
    this._restartTimer = window.setTimeout(() => {
      if (this._state.status === "restarting")
        this._set({ status: "ready", update });
    }, RESTART_TIMEOUT_MS);
  }

  private _fail(update: AvailableUpdate, error: unknown) {
    const failure = installerError(error);
    // A running installation holds back the install or the restart, and the
    // update waits for it
    if (failure.code === "operation_in_progress")
      this._set({ status: "ready", update, blocked: true });
    else this._set({ status: "failed", update, error: failure });
  }

  /** Not now: the update isn't offered again in this run. */
  dismiss(): void {
    const { status } = this._state;
    if (status === "available" || status === "failed" || status === "ready")
      this._set({ status: "none" });
  }

  /** Back to before the first check. */
  reset(): void {
    this._generation++;
    this._check = undefined;
    this._set({ status: "none" });
  }

  private _set(state: InstallerUpdateState) {
    window.clearTimeout(this._restartTimer);
    this._state = state;
    this._listeners.forEach((listener) => listener(state));
  }
}

export const installerUpdate = new InstallerUpdateStore();
