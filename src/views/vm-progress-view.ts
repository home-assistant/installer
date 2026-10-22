import { LitElement, css, html, type PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import { cancelVmInstall } from "../api/commands.js";
import type { FlashProgress } from "../api/types.js";
import { localize } from "../localization/localize.js";
import { wizardState, type WizardState } from "../state/wizard-state.js";
import { InstallDiagnostics, logFrontendError } from "../utils/diagnostics.js";
import {
  haSetupProblemMessage,
  type HaSetupProgress,
} from "../utils/ha-setup.js";
import {
  installerError,
  type InstallerError,
} from "../utils/installer-error.js";
import { isCancelled, throwIfCancelled } from "../utils/polling.js";
import {
  WAIT_STAGES,
  checkedAddress,
  isWaitStage,
  waitError,
  waitForHomeAssistant,
  waitStageDescription,
  waitStageTitle,
  type HomeAssistantWait,
  type WaitStage,
} from "../utils/vm-wait.js";
import "../components/install-progress.js";

/** A flow's own stages from the download on, then the waits, then the end */
export type VmInstallStage<Stage extends string> =
  | "downloading"
  | Stage
  | WaitStage
  | "complete"
  | "error";

/** A failure to show, in `message`'s words if given */
export interface VmInstallFailure {
  error: unknown;
  message?: string;
}

/**
 * What the UTM and Proxmox install views share. Each runs its own steps up
 * to a running VM. This shows them and the waits for Home Assistant that
 * follow, and keeps what the shell relies on: whether the install can still
 * be stopped, whether the user can leave, and a retry after a failure.
 */
export abstract class VmProgressView<Stage extends string> extends LitElement {
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

  @state()
  protected _wizardState: WizardState = wizardState.getState();

  @state()
  protected _stage: VmInstallStage<Stage> = "downloading";

  @state()
  protected _progress = 0;

  @state()
  protected _bytesProcessed = 0;

  @state()
  protected _totalBytes = 0;

  @state()
  protected _error: InstallerError | null = null;

  /** What Supervisor reports while it installs Home Assistant */
  @state()
  protected _setup: HaSetupProgress = { progress: null, problem: null };

  @state()
  private _isInstalling = false;

  /** Whether the backend step that a stop can end runs */
  @state()
  private _inBackendStep = false;

  @state()
  protected _stopping = false;

  /** Names the running backend step, so a late stop can never hit a retry. */
  private _attempt = "";

  /** What the shell last heard about `stoppable`. */
  private _reportedStoppable?: boolean;

  /** What the shell last heard about `leavable`. */
  private _reportedLeavable?: boolean;

  private _stageStartTime: number | null = null;
  private _diagnostics?: InstallDiagnostics;
  private _stageStartBytes: number = 0;
  private _unsubscribe?: () => void;
  private _abortController?: AbortController;

  /** Names the flow in diagnostics */
  protected abstract readonly _flow: "utm" | "proxmox";

  /** The flow's own stages, in order; the waits follow them */
  protected abstract readonly _stages: readonly ("downloading" | Stage)[];

  /** The stages a stop can still end without leaving anything behind */
  protected abstract readonly _stoppableStages: readonly string[];

  /** The stages that report how far they are (0-100%) */
  protected abstract readonly _measurableStages: readonly string[];

  /** What a stop left behind, said instead of a generic "cancelled" */
  protected abstract _stoppedMessage(): string;

  /** A title for one of the flow's own stages, like the waits have theirs */
  protected abstract _stageTitle(stage: "downloading" | Stage): string;

  protected abstract _stageDescription(stage: "downloading" | Stage): string;

  /**
   * What keeps an attempt from starting at all, if anything. It is shown at
   * once, without running any step.
   */
  protected abstract _startFailure(): VmInstallFailure | undefined;

  /**
   * Run the flow's steps up to a running VM, then wait for Home Assistant on
   * it. Resolves with what `install-complete` tells the shell.
   */
  protected abstract _install(
    signal: AbortSignal
  ): Promise<Record<string, unknown>>;

  /** Whether the install operation has failed */
  get hasError(): boolean {
    return this._error !== null;
  }

  /** Whether the user can leave with the VM running and nothing left to start */
  get leavable(): boolean {
    // The VM runs and only Home Assistant is awaited, so leaving loses nothing
    return this._error === null && isWaitStage(this._stage);
  }

  /** Whether `stop` can still end the install without leaving anything behind */
  get stoppable(): boolean {
    return (
      this._inBackendStep &&
      !this._stopping &&
      this._stoppableStages.includes(this._stage)
    );
  }

  /** Stop the install. It ends as a retryable `cancelled` error. */
  stop(): void {
    if (!this.stoppable) return;

    this._stopping = true;
    const attempt = this._attempt;
    cancelVmInstall(attempt).catch((error: unknown) => {
      logFrontendError(error);
      // A late failure must not touch a retry that is stopping by now
      if (attempt !== this._attempt || !this._inBackendStep) return;

      // The install keeps going; show it as such again
      this._stopping = false;
    });
  }

  /**
   * Retry the install operation.
   *
   * Steps that already succeeded are picked up from the wizard state instead
   * of being run again - see each flow's `_install`.
   */
  retry(): void {
    if (!this._error?.retryable) return;
    this._error = null;
    this._stage = "downloading";
    this._progress = 0;
    this._stageStartTime = null;
    this._stageStartBytes = 0;
    void this._startInstall();
  }

  connectedCallback() {
    super.connectedCallback();
    this._wizardState = wizardState.getState();
    // An install must not carry on into a flow started after it
    const generation = wizardState.flowGeneration;
    this._unsubscribe = wizardState.subscribe((state) => {
      this._wizardState = state;
      if (wizardState.flowGeneration !== generation) this._cancelInstall();
    });

    void this._startInstall();
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);

    // The shell offers the stop only while it can still work
    if (this.stoppable !== this._reportedStoppable) {
      this._reportedStoppable = this.stoppable;
      this.dispatchEvent(
        new CustomEvent("install-stoppable", {
          detail: { stoppable: this.stoppable },
          bubbles: true,
          composed: true,
        })
      );
    }
    // And leaving only once the VM runs: a VM that exists but was never
    // started would stay stopped
    if (this.leavable !== this._reportedLeavable) {
      this._reportedLeavable = this.leavable;
      this.dispatchEvent(
        new CustomEvent("install-leavable", {
          detail: { leavable: this.leavable },
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    // Stop the install pipeline. Without this its polling loops keep running
    // after a cancel or a navigation and write wizard state and dispatch
    // events from a component that is no longer in the document. A backend
    // call runs to its end either way; its result is dropped.
    this._cancelInstall();
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
      const detail = await this._install(signal);
      throwIfCancelled(signal);

      // Complete
      this._diagnostics?.advance("complete");
      this._stage = "complete";
      this._progress = 100;

      // Dispatch event to advance wizard
      this.dispatchEvent(
        new CustomEvent("install-complete", {
          bubbles: true,
          composed: true,
          detail,
        })
      );
    } catch (error) {
      if (isCancelled(error) || signal.aborted) {
        // The view was detached mid-install, or its flow ended - leave the
        // wizard alone
        return;
      }

      // Say what a stop left behind, rather than a generic "cancelled"
      const stopped =
        this._stopping && installerError(error).code === "cancelled";
      // Log a wait that ran out as a timeout, not by the words of its message
      this._fail(
        waitError(error),
        stopped ? this._stoppedMessage() : undefined
      );
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
   * Run the backend step a stop can end, from the download on. `step` starts
   * it under the name `stop` asks to end.
   */
  protected async _runBackendStep<T>(
    step: (attempt: string) => Promise<T>
  ): Promise<T> {
    this._diagnostics?.advance("downloading");
    this._stage = "downloading";
    this._progress = 0;
    this._stageStartTime = Date.now();
    this._stageStartBytes = 0;
    this._attempt = crypto.randomUUID();
    this._inBackendStep = true;

    try {
      return await step(this._attempt);
    } finally {
      this._inBackendStep = false;
    }
  }

  /** Show what the backend reports, moving on to `stage` when it is new */
  protected _showProgress(
    stage: VmInstallStage<Stage>,
    progress: FlashProgress
  ) {
    if (stage !== this._stage) {
      this._diagnostics?.advance(stage);
      this._stage = stage;
      this._stageStartTime = Date.now();
      this._stageStartBytes = progress.bytes_processed;
    }

    // In whole percent: the layout shows every digit it gets
    this._progress = Math.round(progress.progress);
    this._bytesProcessed = progress.bytes_processed;
    this._totalBytes = progress.total_bytes;
  }

  /** Move to an indeterminate stage, clearing the previous stage's progress */
  protected _startStage(stage: VmInstallStage<Stage>) {
    this._diagnostics?.advance(stage);
    this._stage = stage;
    this._progress = 0;
    this._stageStartTime = null;
    this._bytesProcessed = 0;
    this._totalBytes = 0;
    this._setup = { progress: null, problem: null };
  }

  /** Wait for Home Assistant on the running VM, and return its address */
  protected _waitForHomeAssistant(
    wait: Pick<HomeAssistantWait, "vmAddress" | "stopOn" | "messages">,
    signal: AbortSignal
  ): Promise<string> {
    return waitForHomeAssistant({
      ...wait,
      onStage: (stage) => this._startStage(stage),
      onSetup: (setup) => {
        this._setup = setup;
        this._progress = Math.round(setup.progress ?? 0);
      },
      signal,
    });
  }

  /** Show a failure, in `message`'s words if given, and tell the shell */
  protected _fail(
    error: unknown,
    message?: string,
    detail: Record<string, unknown> = {}
  ) {
    this._diagnostics?.fail(error);
    this._stage = "error";
    const installer = installerError(
      error,
      localize(
        "views.proxmox.proxmox_progress_view.failed_to_create_virtual_machine"
      )
    );
    this._error = message ? { ...installer, message } : installer;
    this.dispatchEvent(
      new CustomEvent("install-error", {
        detail: { retryable: this._error.retryable, ...detail },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    const stage = this._stage;
    return html`
      <install-progress
        .stages=${[...this._stages, ...WAIT_STAGES].map((id) => ({
          id,
          label:
            id === "updating"
              ? localize(
                  "views.proxmox.proxmox_progress_view.installing_latest_home_assistant"
                )
              : this._getStageDescription(id),
        }))}
        .stage=${stage}
        .stageTitle=${this._stopping
          ? localize("views.sbc.progress_view.stopping")
          : this._getStageTitle(stage)}
        .description=${this._getStageDescription(stage)}
        .progress=${this._progress}
        .bytesProcessed=${this._bytesProcessed}
        .totalBytes=${this._totalBytes}
        .stageStartTime=${this._stageStartTime}
        .stageStartBytes=${this._stageStartBytes}
        .indeterminate=${this._isIndeterminate(stage)}
        .measurable=${this._hasMeasurableProgress(stage)}
        .hideEmptyDetails=${true}
        .error=${this._error?.message ?? null}
        .warning=${stage === "updating" && this._setup.problem
          ? haSetupProblemMessage(this._setup.problem)
          : null}
        .address=${checkedAddress(
          stage,
          this._wizardState.selections.ipAddress
        )}
        .leavable=${this.leavable}
      ></install-progress>
    `;
  }

  /** Check if a stage uses indeterminate progress */
  private _isIndeterminate(stage: VmInstallStage<Stage>): boolean {
    // Every stage before the end waits for something, unless it can measure
    return (
      stage !== "complete" &&
      stage !== "error" &&
      !this._hasMeasurableProgress(stage)
    );
  }

  /** Check if a stage has measurable progress (0-100%) */
  private _hasMeasurableProgress(stage: VmInstallStage<Stage>): boolean {
    // Once Supervisor reports downloading Core
    if (stage === "updating") return this._setup.progress !== null;
    return (
      this._measurableStages.includes(stage) &&
      (stage === "downloading" || this._totalBytes > 0)
    );
  }

  private _getStageTitle(stage: VmInstallStage<Stage>): string {
    if (stage === "complete") {
      return localize("views.proxmox.proxmox_progress_view.complete");
    }
    if (stage === "error") return localize("common.error");
    return isWaitStage(stage) ? waitStageTitle(stage) : this._stageTitle(stage);
  }

  private _getStageDescription(stage: VmInstallStage<Stage>): string {
    if (stage === "complete") {
      return localize("api.commands.installation_complete");
    }
    // The layout shows the error instead
    if (stage === "error") {
      return localize(
        "views.proxmox.proxmox_progress_view.installing_home_assistant"
      );
    }
    return isWaitStage(stage)
      ? waitStageDescription(stage)
      : this._stageDescription(stage);
  }
}
