import {
  installerError,
  type InstallerError,
} from "../../utils/installer-error.js";
import { localize } from "../../localization/localize.js";
import { LitElement, html, css, type PropertyValues } from "lit";
import {
  InstallDiagnostics,
  logFrontendError,
} from "../../utils/diagnostics.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import {
  cancelVmInstall,
  proxmoxCreateVm,
  proxmoxGetVmStatus,
} from "../../api/commands.js";
import type {
  FlashProgress,
  FlashStage,
  ProxmoxSession,
  ProxmoxVmConfig,
  ProxmoxVmResult,
} from "../../api/types.js";
import { proxmoxVmConfig } from "../../state/vm-defaults.js";
import { isCancelled, throwIfCancelled } from "../../utils/polling.js";
import {
  checkedAddress,
  isWaitStage,
  waitError,
  waitForHomeAssistant,
  type WaitStage,
} from "../../utils/vm-wait.js";
import {
  haSetupProblemMessage,
  type HaSetupProgress,
} from "../../utils/ha-setup.js";
import {
  SESSION_EXPIRED,
  forgetProxmoxSession,
  needsReconnect,
} from "./proxmox-session.js";
import "../../components/install-progress.js";

/** The stages `proxmoxCreateVm` reports, in order */
const BACKEND_STAGES = [
  "downloading",
  "extracting",
  "uploading",
  "creating_vm",
  "starting_vm",
] as const satisfies readonly FlashStage[];

type BackendStage = (typeof BACKEND_STAGES)[number];

/** Past these, the VM exists, and the install runs to the end */
const STOPPABLE_STAGES: InstallStage[] = [
  "downloading",
  "extracting",
  "uploading",
];

/** The backend's stages, then the waits for the VM and Home Assistant run from here */
type InstallStage = BackendStage | WaitStage | "complete" | "error";

function isBackendStage(stage: FlashStage): stage is BackendStage {
  return (BACKEND_STAGES as readonly FlashStage[]).includes(stage);
}

// Stages that have measurable progress (0-100%)
const MEASURABLE_STAGES: InstallStage[] = [
  "downloading",
  "extracting",
  "uploading",
];

// Stages that use indeterminate progress (waiting for something, or unknown total size)
const INDETERMINATE_STAGES: InstallStage[] = [
  "extracting",
  "uploading",
  "creating_vm",
  "starting_vm",
  "waiting",
  "ready",
  "updating",
];

/**
 * Whether a failed VM status request cannot succeed by asking again.
 *
 * An expired session or a missing permission fails every poll the same way,
 * and waiting out the timeout would hide it behind "no IP address". Errors
 * without a structured code are still treated as "not ready yet".
 */
function needsUserAction(error: unknown): boolean {
  const { code, retryable } = installerError(error);
  if (code === "unknown") return false;
  return !retryable || code === "proxmox_action_required";
}

@customElement("proxmox-progress-view")
export class ProxmoxProgressView extends LitElement {
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
  private _wizardState: WizardState = wizardState.getState();

  @state()
  private _stage: InstallStage = "downloading";

  @state()
  private _progress = 0;

  @state()
  private _bytesProcessed = 0;

  @state()
  private _totalBytes = 0;

  @state()
  private _error: InstallerError | null = null;

  /** What Supervisor reports while it installs Home Assistant */
  @state()
  private _setup: HaSetupProgress = { progress: null, problem: null };

  @state()
  private _isInstalling = false;

  /** Whether the backend install (download up to starting the VM) runs */
  @state()
  private _creatingVm = false;

  @state()
  private _stopping = false;

  /** Names the running backend install, so a late stop can never hit a retry. */
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
      this._creatingVm &&
      !this._stopping &&
      STOPPABLE_STAGES.includes(this._stage)
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
      if (attempt !== this._attempt || !this._creatingVm) return;

      // The install keeps going; show it as such again
      this._stopping = false;
    });
  }

  /**
   * Retry the install operation.
   *
   * A VM created by an earlier attempt is picked up from the wizard state
   * instead of being created again. See `_startInstall`.
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
    this._unsubscribe = wizardState.subscribe((state) => {
      this._wizardState = state;
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
    // Stop reporting on the install. The backend call runs to completion
    // either way, but a detached component must not write wizard state or
    // dispatch events once the user has cancelled or navigated away.
    this._cancelInstall();
  }

  private _cancelInstall() {
    this._abortController?.abort();
    this._abortController = undefined;
    this._isInstalling = false;
  }

  private async _startInstall() {
    if (this._isInstalling) return;
    this._diagnostics = new InstallDiagnostics("proxmox");

    const selections = this._wizardState.selections;
    const session = selections.proxmoxSession;

    if (!session) {
      // Answered like an expired one: by logging in again
      this._setError(
        { code: SESSION_EXPIRED, message: "", retryable: false, details: {} },
        localize(
          "views.proxmox.proxmox_progress_view.no_proxmox_session_available"
        )
      );
      return;
    }

    const controller = new AbortController();
    this._abortController = controller;
    const { signal } = controller;

    this._isInstalling = true;
    this._error = null;

    const config = proxmoxVmConfig(selections);

    try {
      // Skipped when an earlier attempt already created the VM: running it
      // again after a late failure would try to create a second VM with the
      // same id, which Proxmox rejects.
      let result = selections.proxmoxVmResult;
      if (!result) {
        result = await this._createVm(session, config, signal);
        throwIfCancelled(signal);
        wizardState.setSelection("proxmoxVmResult", result);
      }

      const { node, vm_id } = result;
      await waitForHomeAssistant({
        vmAddress: async () =>
          (await proxmoxGetVmStatus(session, node, vm_id)).ip_address,
        stopOn: needsUserAction,
        onStage: (stage) => this._startStage(stage),
        onSetup: (setup) => {
          this._setup = setup;
          this._progress = Math.round(setup.progress ?? 0);
        },
        messages: {
          noAddress: localize(
            "views.proxmox.proxmox_progress_view.the_virtual_machine_did_not_report_an_ip_address"
          ),
          notResponding: (ipAddress) =>
            localize(
              "views.proxmox.proxmox_progress_view.home_assistant_did_not_respond_at_value_within_5_minutes",
              { value0: ipAddress }
            ),
          notUpdated: (address) =>
            localize("views.proxmox.proxmox_progress_view.update_timeout", {
              address,
            }),
        },
        signal,
      });

      // Complete
      this._stage = "complete";
      this._diagnostics?.advance("complete");
      this._progress = 100;

      // Dispatch event to advance wizard
      this.dispatchEvent(
        new CustomEvent("install-complete", {
          bubbles: true,
          composed: true,
          detail: { result },
        })
      );
    } catch (error) {
      if (isCancelled(error) || signal.aborted) {
        // The view was detached mid-install - leave the wizard alone
        return;
      }

      // Say what a stop left behind, rather than a generic "cancelled"
      const stopped =
        this._stopping && installerError(error).code === "cancelled";
      this._setError(
        waitError(error),
        stopped
          ? localize(
              "views.proxmox.proxmox_progress_view.stopped_nothing_created"
            )
          : undefined
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

  /** Create and start the VM, reporting the backend's progress */
  private async _createVm(
    session: ProxmoxSession,
    config: ProxmoxVmConfig,
    signal: AbortSignal
  ): Promise<ProxmoxVmResult> {
    this._stage = "downloading";
    this._diagnostics?.advance("downloading");
    this._stageStartTime = Date.now();
    this._stageStartBytes = 0;
    this._attempt = crypto.randomUUID();
    this._creatingVm = true;

    try {
      const result = await this._reportCreation(session, config, signal);
      // A stop that came too late: the VM exists, so the install goes on
      this._stopping = false;
      return result;
    } finally {
      this._creatingVm = false;
    }
  }

  private _reportCreation(
    session: ProxmoxSession,
    config: ProxmoxVmConfig,
    signal: AbortSignal
  ): Promise<ProxmoxVmResult> {
    return proxmoxCreateVm(
      session,
      config,
      (progress: FlashProgress) => {
        // Progress keeps arriving from the backend after a cancel; a
        // detached view must stop reporting on it
        if (signal.aborted) return;

        if (!isBackendStage(progress.stage)) {
          // A stage the backend gained without this view learning it
          console.warn(
            `Ignoring unknown Proxmox install stage: ${progress.stage}`
          );
          return;
        }

        // Use raw per-stage progress
        this._diagnostics?.advance(progress.stage);
        if (progress.stage !== this._stage) {
          this._stage = progress.stage;
          this._stageStartTime = Date.now();
          this._stageStartBytes = progress.bytes_processed;
        }

        this._progress = progress.progress;
        this._bytesProcessed = progress.bytes_processed;
        this._totalBytes = progress.total_bytes;
      },
      this._attempt
    );
  }

  /** Move to an indeterminate stage, clearing the previous stage's progress */
  private _startStage(stage: InstallStage) {
    this._diagnostics?.advance(stage);
    this._stage = stage;
    this._progress = 0;
    this._stageStartTime = null;
    this._bytesProcessed = 0;
    this._totalBytes = 0;
    this._setup = { progress: null, problem: null };
  }

  /**
   * Show an error and tell the shell whether a retry is safe, or whether
   * only logging in again can get past it.
   */
  private _setError(error: unknown, message?: string) {
    // Reconnecting resumes a VM made in full, or starts one not made yet. A
    // VM that failed while being made may exist half way, unknown to the
    // installer: a new install would find its VM ID taken, or leave it
    // behind under another one.
    const halfMade =
      !STOPPABLE_STAGES.includes(this._stage) &&
      !wizardState.getState().selections.proxmoxVmResult;
    const reconnect = needsReconnect(error) && !halfMade;
    if (needsReconnect(error) && halfMade) {
      message = localize(
        "views.proxmox.proxmox_progress_view.connection_lost_while_creating"
      );
    }
    this._diagnostics?.fail(error);
    this._stage = "error";
    const installer = installerError(
      error,
      localize(
        "views.proxmox.proxmox_progress_view.failed_to_create_virtual_machine"
      )
    );
    this._error = message ? { ...installer, message } : installer;
    if (reconnect) forgetProxmoxSession();
    this.dispatchEvent(
      new CustomEvent("install-error", {
        detail: { retryable: this._error.retryable, reconnect },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    const stage = this._stage;
    return html`
      <install-progress
        .stages=${[
          "downloading",
          "extracting",
          "uploading",
          "creating_vm",
          "starting_vm",
          "waiting",
          "ready",
          "updating",
        ].map((id) => ({
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

  /** Check if the current stage uses indeterminate progress */
  private _isIndeterminate(stage: InstallStage): boolean {
    return (
      INDETERMINATE_STAGES.includes(stage) &&
      !this._hasMeasurableProgress(stage)
    );
  }

  /** Check if the current stage has measurable progress */
  private _hasMeasurableProgress(stage: InstallStage): boolean {
    // Once Supervisor reports downloading Core
    if (stage === "updating") return this._setup.progress !== null;
    return (
      MEASURABLE_STAGES.includes(stage) &&
      (stage === "downloading" || this._totalBytes > 0)
    );
  }

  private _getStageTitle(stage: string): string {
    switch (stage) {
      case "downloading":
        return localize("views.proxmox.proxmox_progress_view.downloading");
      case "extracting":
        return localize("views.sbc.progress_view.extracting");
      case "uploading":
        return localize("views.proxmox.proxmox_progress_view.uploading");
      case "creating_vm":
        return localize("views.proxmox.proxmox_progress_view.creating");
      case "starting_vm":
        return localize("views.proxmox.proxmox_progress_view.starting");
      case "waiting":
        return localize("views.proxmox.proxmox_progress_view.connecting");
      case "ready":
        return localize("views.proxmox.proxmox_progress_view.waiting");
      case "updating":
        return localize("views.proxmox.proxmox_progress_view.updating");
      case "complete":
        return localize("views.proxmox.proxmox_progress_view.complete");
      case "error":
        return localize("common.error");
      default:
        return localize("views.proxmox.proxmox_progress_view.installing");
    }
  }

  private _getStageDescription(stage: string): string {
    switch (stage) {
      case "downloading":
        return localize(
          "views.proxmox.proxmox_progress_view.downloading_home_assistant_os"
        );
      case "extracting":
        return localize("views.sbc.progress_view.extracting_the_image");
      case "uploading":
        return localize(
          "views.proxmox.proxmox_progress_view.uploading_image_to_proxmox"
        );
      case "creating_vm":
        return localize(
          "views.proxmox.proxmox_progress_view.creating_virtual_machine"
        );
      case "starting_vm":
        return localize(
          "views.proxmox.proxmox_progress_view.starting_home_assistant_os"
        );
      case "waiting":
        return localize(
          "views.proxmox.proxmox_progress_view.waiting_for_network_connection"
        );
      case "ready":
        return localize(
          "views.proxmox.proxmox_progress_view.waiting_for_home_assistant"
        );
      case "updating":
        return localize(
          "views.proxmox.proxmox_progress_view.installing_latest_home_assistant_this_can_take_up_to_20_minutes"
        );
      case "complete":
        return localize("api.commands.installation_complete");
      default:
        return localize(
          "views.proxmox.proxmox_progress_view.installing_home_assistant"
        );
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "proxmox-progress-view": ProxmoxProgressView;
  }
}
