import { LitElement, css, type PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../state/wizard-state.js";
import { WizardStateController } from "../state/wizard-state-controller.js";
import {
  InstallDiagnostics,
  logFrontendError,
  type DiagnosticFlow,
} from "../utils/diagnostics.js";
import {
  installerError,
  type InstallerError,
} from "../utils/installer-error.js";
import { fireEvent } from "../utils/fire-event.js";
import { isCancelled, throwIfCancelled } from "../utils/polling.js";

/** A failure to show, in `message`'s words if given */
export interface InstallFailure {
  error: unknown;
  message?: string;
}

/**
 * What every install progress view shares. It runs the install as soon as it
 * opens, and tells the shell how it goes:
 *
 * - `install-stoppable` and `install-leavable` whenever `stoppable` or
 *   `leavable` changes, so the shell offers Cancel only while it works
 * - `install-complete`, once the install is done
 * - `install-error`, with whether `retry` can work, and whether choosing
 *   differently can, like another drive
 */
export abstract class InstallProgressView extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100%;
    }
    install-progress {
      width: 100%;
      flex: 1;
    }
  `;

  private readonly _wizard = new WizardStateController(this, () => {
    // An install must not carry on into a flow started after it
    if (wizardState.flowGeneration !== this._flowGeneration) {
      this._cancelInstall();
    }
  });

  protected get _wizardState(): WizardState {
    return this._wizard.state;
  }

  @state()
  protected _error: InstallerError | null = null;

  @state()
  protected _stopping = false;

  /**
   * Names the running step that a stop can end, so a late stop can never hit
   * a retry. Empty while none runs.
   */
  @state()
  private _attempt = "";

  protected _stageStartTime: number | null = null;
  protected _stageStartBytes = 0;
  protected _diagnostics?: InstallDiagnostics;

  private _isInstalling = false;

  /** What the shell last heard about `stoppable`. */
  private _reportedStoppable?: boolean;

  /** What the shell last heard about `leavable`. */
  private _reportedLeavable?: boolean;

  /** The flow the install runs for */
  private _flowGeneration = 0;
  private _abortController?: AbortController;

  /** Names the flow in diagnostics */
  protected abstract readonly _flow: DiagnosticFlow;

  /** Run the install, resolving once it is done */
  protected abstract _install(signal: AbortSignal): Promise<void>;

  /** Ask the backend to stop the step that runs as `attempt` */
  protected abstract _cancel(attempt: string): Promise<void>;

  /** What a stop left behind, said instead of a generic "cancelled" */
  protected abstract _stoppedMessage(): string;

  /** Clear the progress of the attempt that failed, before a retry */
  protected abstract _resetProgress(): void;

  /**
   * What keeps an attempt from starting at all, if anything. It is shown at
   * once, without running any step.
   */
  protected _startFailure(): InstallFailure | undefined {
    return undefined;
  }

  /** The failure to show for `error` */
  protected _installerError(error: unknown): InstallerError {
    return installerError(error);
  }

  /**
   * Whether choosing differently, like another drive, can fix `error`. The
   * shell then leads Next back to that choice; otherwise there is nothing
   * to pick instead.
   */
  protected _choiceCanFix(_error: InstallerError): boolean {
    return false;
  }

  /** Whether `stop` can still end the install */
  get stoppable(): boolean {
    return !!this._attempt && !this._stopping;
  }

  /** Whether the user can leave, and the install finishes on its own */
  get leavable(): boolean {
    return false;
  }

  /** Stop the install. It ends as a retryable `cancelled` error. */
  stop(): void {
    if (!this.stoppable) return;

    this._stopping = true;
    // So the shell hides Cancel right away, not only after the next render
    this._report();
    const attempt = this._attempt;
    this._cancel(attempt).catch((error: unknown) => {
      logFrontendError(error);
      // A late failure must not touch a retry that is stopping by now
      if (attempt !== this._attempt) return;

      // The install keeps going; show it as such again
      this._stopping = false;
    });
  }

  /** Run the failed install again, if trying again can work. */
  retry(): void {
    if (!this._error?.retryable) return;
    this._error = null;
    this._stageStartTime = null;
    this._stageStartBytes = 0;
    this._resetProgress();
    void this._startInstall();
  }

  connectedCallback() {
    super.connectedCallback();
    this._flowGeneration = wizardState.flowGeneration;
    void this._startInstall();
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    this._report();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // Stop the install pipeline. Without this its polling loops keep running
    // after a cancel or a navigation and write wizard state and dispatch
    // events from a component that is no longer in the document. A backend
    // call runs to its end either way; its result is dropped.
    this._cancelInstall();
  }

  /** Tell the shell when stopping or leaving became possible, or no longer is */
  private _report() {
    if (this.stoppable !== this._reportedStoppable) {
      this._reportedStoppable = this.stoppable;
      fireEvent(this, "install-stoppable", { stoppable: this.stoppable });
    }
    if (this.leavable !== this._reportedLeavable) {
      this._reportedLeavable = this.leavable;
      fireEvent(this, "install-leavable", { leavable: this.leavable });
    }
  }

  private _cancelInstall() {
    this._abortController?.abort();
    this._abortController = undefined;
    this._isInstalling = false;
  }

  private async _startInstall() {
    if (this._isInstalling) return;
    this._diagnostics = new InstallDiagnostics(this._flow);

    const failure = this._startFailure();
    if (failure) {
      this._fail(failure.error, failure.message);
      return;
    }

    const controller = new AbortController();
    this._abortController = controller;
    const { signal } = controller;

    this._isInstalling = true;
    this._error = null;

    try {
      await this._install(signal);
      throwIfCancelled(signal);
      this._complete();
    } catch (error) {
      if (isCancelled(error) || signal.aborted) {
        // The view was detached mid-install, or its flow ended - leave the
        // wizard alone
        return;
      }

      // Say what a stop left behind, rather than a generic "cancelled"
      const stopped =
        this._stopping && installerError(error).code === "cancelled";
      this._fail(error, stopped ? this._stoppedMessage() : undefined);
    } finally {
      // A newer attempt may own the component by now (cancel, then retry)
      if (this._abortController === controller) {
        this._isInstalling = false;
        this._abortController = undefined;
        this._stopping = false;
      }
    }
  }

  /**
   * Run `step`, which a stop can end, under the name `stop` asks the backend
   * to end.
   */
  protected async _runStoppable<T>(
    step: (attempt: string) => Promise<T>
  ): Promise<T> {
    const attempt = crypto.randomUUID();
    this._attempt = attempt;
    try {
      return await step(attempt);
    } finally {
      if (this._attempt === attempt) this._attempt = "";
    }
  }

  /** The install is done: tell the shell, which moves on */
  protected _complete() {
    this._diagnostics?.advance("complete");
    fireEvent(this, "install-complete");
  }

  /** Show a failure, in `message`'s words if given, and tell the shell */
  protected _fail(
    error: unknown,
    message?: string,
    detail: Partial<HAIEvents["install-error"]> = {}
  ) {
    this._diagnostics?.fail(error);
    const installer = this._installerError(error);
    this._error = message ? { ...installer, message } : installer;
    fireEvent(this, "install-error", {
      retryable: this._error.retryable,
      changeChoice: this._choiceCanFix(this._error),
      ...detail,
    });
  }
}

declare global {
  interface HAIEvents {
    "install-stoppable": { stoppable: boolean };
    "install-leavable": { leavable: boolean };
    "install-complete": undefined;
    "install-error": {
      /** Trying the same again can work */
      retryable: boolean;
      /** Choosing differently can, like another drive */
      changeChoice: boolean;
      /** Only logging in again can get past it */
      reconnect?: boolean;
    };
  }
}
