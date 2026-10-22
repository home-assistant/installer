import {
  installerError,
  type InstallerError,
} from "../../utils/installer-error.js";
import { LitElement, html, css, type PropertyValues } from "lit";
import { localize } from "../../localization/localize.js";
import {
  InstallDiagnostics,
  logFrontendError,
} from "../../utils/diagnostics.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import {
  cancelVmInstall,
  downloadUtmImage,
  discardUtmImage,
  createUtmVm,
  startUtmVm,
  getUtmVmStatus,
  type VmStatusInfo,
} from "../../api/commands.js";
import type { FlashProgress, UtmVmConfig } from "../../api/types.js";
import { utmVmConfig } from "../../state/vm-defaults.js";
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
import "../../components/install-progress.js";

type InstallStage =
  | "downloading"
  | "extracting"
  | "creating"
  | "starting"
  | WaitStage
  | "complete"
  | "error";

/** Past these, UTM creates the VM, and the install runs to the end */
const STOPPABLE_STAGES: InstallStage[] = ["downloading", "extracting"];

/**
 * Whether a failed VM status request cannot succeed by asking again.
 *
 * When UTM answers with an error, like missing Automation access or a VM
 * that was removed, it answers the same way every time, and waiting would
 * only hide the cause behind "no IP address". No answer at all, like a UTM
 * that is busy starting the VM, can pass. Errors without a structured code
 * are still treated as "not ready yet".
 */
function failsEveryTime(error: unknown): boolean {
  const { code } = installerError(error);
  return code === "utm" || code === "unsupported_platform";
}

/** Shaped like the backend's rejection after a stop. */
const STOPPED = {
  code: "cancelled",
  message: "Installation was cancelled.",
  retryable: true,
  details: {},
};

// Stages that have measurable progress (0-100%)
const MEASURABLE_STAGES: InstallStage[] = ["downloading", "extracting"];

// Stages that use indeterminate progress (waiting for something, or unknown total size)
const INDETERMINATE_STAGES: InstallStage[] = [
  "extracting",
  "creating",
  "starting",
  "waiting",
  "ready",
  "updating",
];

/** VM statuses that mean the VM does not need to be started again */
const RUNNING_VM_STATUSES = ["started", "running", "starting", "resuming"];

@customElement("utm-progress-view")
export class UtmProgressView extends LitElement {
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

  /** Whether the image download (and its extraction) runs */
  @state()
  private _downloading = false;

  @state()
  private _stopping = false;

  /** Names the running download, so a late stop can never hit a retry. */
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

  /** Whether `stop` can still end the install before UTM creates anything */
  get stoppable(): boolean {
    return (
      this._downloading &&
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
      if (attempt !== this._attempt || !this._downloading) return;

      // The download keeps going; show it as such again
      this._stopping = false;
    });
  }

  /** Check if a stage uses indeterminate progress */
  private _isIndeterminate(stage: InstallStage): boolean {
    return (
      INDETERMINATE_STAGES.includes(stage) &&
      !this._hasMeasurableProgress(stage)
    );
  }

  /** Check if a stage has measurable progress (0-100%) */
  private _hasMeasurableProgress(stage: InstallStage): boolean {
    // Once Supervisor reports downloading Core
    if (stage === "updating") return this._setup.progress !== null;
    return (
      MEASURABLE_STAGES.includes(stage) &&
      (stage === "downloading" || this._totalBytes > 0)
    );
  }

  /**
   * Retry the install operation.
   *
   * Steps that already succeeded are picked up from the wizard state instead
   * of being run again - see `_startInstall`.
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
    // events from a component that is no longer in the document.
    this._cancelInstall();
  }

  private _cancelInstall() {
    this._abortController?.abort();
    this._abortController = undefined;
    this._isInstalling = false;
  }

  private async _startInstall() {
    if (this._isInstalling) return;

    const controller = new AbortController();
    this._abortController = controller;
    const { signal } = controller;

    this._isInstalling = true;
    this._diagnostics = new InstallDiagnostics("utm");
    this._error = null;

    const selections = this._wizardState.selections;
    const flowGeneration = wizardState.flowGeneration;
    let imagePath: string | undefined;

    try {
      // Every step below is skipped when an earlier attempt already completed
      // it. Running the whole pipeline again after a late failure would create
      // a second VM with the same name and orphan the first one.
      let vmId = selections.vmId;
      if (!vmId) {
        if (selections.utmSupersededVmId) {
          throw new Error(
            localize(
              "views.utm.utm_progress_view.a_virtual_machine_was_already_created_with_earlier_settings"
            )
          );
        }
        const pending = selections.utmCreation;
        imagePath = pending ? undefined : await this._downloadImage(signal);
        throwIfCancelled(signal);
        // A stop that landed as the download finished still holds back the VM
        if (this._stopping) throw STOPPED;
        this._startStage("creating");

        const config: UtmVmConfig = {
          ...utmVmConfig(selections),
          image_path: pending?.config.image_path ?? imagePath!,
        };

        vmId = await this._createVm(config, flowGeneration);
        throwIfCancelled(signal);
      }

      this._startStage("starting");
      await this._ensureVmStarted(vmId, signal);
      throwIfCancelled(signal);

      const startedVmId = vmId;
      const ipAddress = await waitForHomeAssistant({
        vmAddress: async () => (await getUtmVmStatus(startedVmId)).ip_address,
        stopOn: failsEveryTime,
        onStage: (stage) => this._startStage(stage),
        onSetup: (setup) => {
          this._setup = setup;
          this._progress = Math.round(setup.progress ?? 0);
        },
        messages: {
          noAddress: localize(
            "views.utm.utm_progress_view.the_virtual_machine_did_not_report_an_ip_address"
          ),
          notResponding: (ipAddress) =>
            localize(
              "views.utm.utm_progress_view.home_assistant_did_not_respond_at_value_within_5_minutes",
              { value0: ipAddress }
            ),
          notUpdated: (address) => localize("utm.update_timeout", { address }),
        },
        signal,
      });

      // Complete
      this._diagnostics?.advance("complete");
      this._stage = "complete";
      this._progress = 100;

      // Dispatch event to advance wizard
      this.dispatchEvent(
        new CustomEvent("install-complete", {
          bubbles: true,
          composed: true,
          detail: { ipAddress },
        })
      );
    } catch (error) {
      if (
        isCancelled(error) ||
        signal.aborted ||
        wizardState.flowGeneration !== flowGeneration
      ) {
        // The view was detached mid-install - leave the wizard alone
        return;
      }

      this._diagnostics?.fail(error);
      this._stage = "error";
      const installer = installerError(
        waitError(error),
        localize(
          "views.proxmox.proxmox_progress_view.failed_to_create_virtual_machine"
        )
      );
      // Say what a stop left behind, rather than a generic "cancelled"
      this._error =
        this._stopping && installer.code === "cancelled"
          ? {
              ...installer,
              message: localize(
                "views.utm.utm_progress_view.stopped_nothing_created"
              ),
            }
          : installer;
      this.dispatchEvent(
        new CustomEvent("install-error", {
          detail: { retryable: this._error.retryable },
          bubbles: true,
          composed: true,
        })
      );
    } finally {
      // A newer attempt may own the component by now (cancel, then retry)
      if (this._abortController === controller) {
        this._isInstalling = false;
        this._abortController = undefined;
        this._stopping = false;
      }
      if (imagePath) {
        try {
          await discardUtmImage(imagePath);
        } catch (error) {
          logFrontendError(error);
        }
      }
    }
  }

  private _createVm(config: UtmVmConfig, generation: number): Promise<string> {
    const changed = () =>
      new Error(
        localize(
          "views.utm.utm_progress_view.the_installation_changed_while_the_virtual_machine_was_being_created"
        )
      );
    const pending = wizardState.getState().selections.utmCreation;
    if (pending) {
      if (
        pending.config.name !== config.name ||
        pending.config.image_path !== config.image_path ||
        pending.config.cpu_cores !== config.cpu_cores ||
        pending.config.memory_mb !== config.memory_mb ||
        pending.config.disk_size_gb !== config.disk_size_gb
      ) {
        return Promise.reject(changed());
      }
      return pending.result;
    }

    // Persist the result once, before any awaiting view can start it.
    const result = createUtmVm(config)
      .then((vmId) => {
        const current = wizardState.getState().selections;
        if (wizardState.flowGeneration !== generation || current.vmId) {
          throw changed();
        }
        const chosen = utmVmConfig(current);
        if (
          chosen.name !== config.name ||
          chosen.cpu_cores !== config.cpu_cores ||
          chosen.memory_mb !== config.memory_mb ||
          chosen.disk_size_gb !== config.disk_size_gb
        ) {
          wizardState.setSelection("utmSupersededVmId", vmId);
          throw changed();
        }
        wizardState.setSelection("vmId", vmId);
        return vmId;
      })
      .finally(() => {
        if (wizardState.getState().selections.utmCreation?.result === result) {
          wizardState.setSelection("utmCreation", undefined);
        }
      });
    wizardState.setSelection("utmCreation", { config, result });
    return result;
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

  /** Download the HAOS qcow2 image, reporting download and extract progress */
  private async _downloadImage(signal: AbortSignal): Promise<string> {
    this._diagnostics?.advance("downloading");
    this._stage = "downloading";
    this._progress = 0;
    this._stageStartTime = Date.now();
    this._stageStartBytes = 0;
    this._attempt = crypto.randomUUID();
    this._downloading = true;

    try {
      return await this._reportDownload(signal);
    } finally {
      this._downloading = false;
    }
  }

  private _reportDownload(signal: AbortSignal): Promise<string> {
    return downloadUtmImage((progress: FlashProgress) => {
      // Only a stop ends the download early, but a detached view must stop
      // reporting on it
      if (signal.aborted) return;

      // Track stage changes
      if (progress.stage === "extracting" && this._stage === "downloading") {
        this._diagnostics?.advance("extracting");
        this._stage = "extracting";
        this._stageStartTime = Date.now();
        this._stageStartBytes = progress.bytes_processed;
      }

      // Use raw per-stage progress (0-100%)
      this._progress = Math.round(progress.progress);
      this._bytesProcessed = progress.bytes_processed;
      this._totalBytes = progress.total_bytes;
    }, this._attempt);
  }

  /**
   * Start the VM unless it is already running.
   *
   * A resumed attempt can find the VM already running or starting.
   */
  private async _ensureVmStarted(
    vmId: string,
    signal: AbortSignal
  ): Promise<void> {
    let status: VmStatusInfo | null = null;
    try {
      status = await getUtmVmStatus(vmId);
    } catch {
      // Status is not available (yet) - fall through and start the VM
    }

    throwIfCancelled(signal);

    if (status && RUNNING_VM_STATUSES.includes(status.status)) {
      return;
    }

    await startUtmVm(vmId);
  }

  render() {
    const stage = this._stage;
    return html`
      <install-progress
        .stages=${[
          "downloading",
          "extracting",
          "creating",
          "starting",
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

  private _getStageTitle(stage: string): string {
    switch (stage) {
      case "downloading":
        return localize("views.proxmox.proxmox_progress_view.downloading");
      case "extracting":
        return localize("views.sbc.progress_view.extracting");
      case "creating":
        return localize("views.proxmox.proxmox_progress_view.creating");
      case "starting":
        return localize("views.proxmox.proxmox_progress_view.starting");
      case "waiting":
        return localize("views.proxmox.proxmox_progress_view.waiting");
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
      case "creating":
        return localize(
          "views.proxmox.proxmox_progress_view.creating_virtual_machine"
        );
      case "starting":
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
    "utm-progress-view": UtmProgressView;
  }
}
