import {
  installerError,
  type InstallerError,
} from "../../utils/installer-error.js";
import { localize } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { InstallDiagnostics } from "../../utils/diagnostics.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import {
  checkHaReady,
  checkHaUpdated,
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
import {
  DEFAULT_CPU_CORES,
  DEFAULT_DISK_SIZE_GB,
  DEFAULT_MEMORY_MB,
  DEFAULT_PROXMOX_NODE,
  DEFAULT_PROXMOX_STORAGE,
  DEFAULT_PROXMOX_VM_ID,
  DEFAULT_PROXMOX_VM_NAME,
} from "../../state/vm-defaults.js";
import {
  PollTimeoutError,
  isCancelled,
  pollUntil,
  throwIfCancelled,
} from "../../utils/polling.js";
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

/** The backend's stages, then the waits for the VM and Home Assistant run from here */
type InstallStage =
  | BackendStage
  | "waiting"
  | "ready"
  | "updating"
  | "complete"
  | "error";

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

/** Delay between polls while waiting for the VM and Home Assistant */
const POLL_INTERVAL_MS = 2000;

/** How long to wait for the VM to report an IP address */
const VM_IP_TIMEOUT_MS = 5 * 60 * 1000;

/** How long to wait for the Home Assistant webserver to answer */
const HA_READY_TIMEOUT_MS = 5 * 60 * 1000;

/** How long to wait for Home Assistant to finish updating itself */
const HA_UPDATED_TIMEOUT_MS = 60 * 60 * 1000;

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
      display: block;
      height: 100%;
    }
    install-progress {
      width: 100%;
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

  @state()
  private _isInstalling = false;

  private _stageStartTime: number | null = null;
  private _diagnostics?: InstallDiagnostics;
  private _stageStartBytes: number = 0;
  private _unsubscribe?: () => void;
  private _abortController?: AbortController;

  /** Whether the install operation has failed */
  get hasError(): boolean {
    return this._error !== null;
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
      this._setError(
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

    const config: ProxmoxVmConfig = {
      node: selections.proxmoxNode || DEFAULT_PROXMOX_NODE,
      storage: selections.proxmoxStorage || DEFAULT_PROXMOX_STORAGE,
      bridge: selections.proxmoxBridge ?? "",
      vlan_tag: selections.proxmoxVlanTag,
      vm_id: selections.proxmoxVmId ?? DEFAULT_PROXMOX_VM_ID,
      name: selections.vmName || DEFAULT_PROXMOX_VM_NAME,
      cpu_cores: selections.cpuCores ?? DEFAULT_CPU_CORES,
      memory_mb: selections.memoryMb ?? DEFAULT_MEMORY_MB,
      disk_size_gb: selections.diskSizeGb ?? DEFAULT_DISK_SIZE_GB,
      auto_start: true,
    };

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

      // Wait for the VM to get an IP address. Asked again on a retry rather
      // than reusing the last one: a restarted VM can get a new DHCP lease.
      this._startStage("waiting");
      wizardState.setSelection("ipAddress", undefined);
      const ipAddress = await this._waitForVmIp(session, result, signal);
      throwIfCancelled(signal);
      wizardState.setSelection("ipAddress", ipAddress);

      // Wait for the Home Assistant webserver to be ready
      this._startStage("ready");
      await this._waitForHaReady(ipAddress, signal);
      throwIfCancelled(signal);

      // Wait for Home Assistant to finish updating
      this._startStage("updating");
      await this._waitForHaUpdated(ipAddress, signal);
      throwIfCancelled(signal);

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

      this._setError(
        error instanceof PollTimeoutError
          ? {
              code: "timeout",
              message: error.message,
              retryable: true,
              details: {},
            }
          : error
      );
    } finally {
      // A newer attempt may own the component by now (cancel, then retry)
      if (this._abortController === controller) {
        this._isInstalling = false;
        this._abortController = undefined;
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

    return proxmoxCreateVm(session, config, (progress: FlashProgress) => {
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
    });
  }

  /** Move to an indeterminate stage, clearing the previous stage's progress */
  private _startStage(stage: InstallStage) {
    this._diagnostics?.advance(stage);
    this._stage = stage;
    this._progress = 0;
    this._stageStartTime = null;
    this._bytesProcessed = 0;
    this._totalBytes = 0;
  }

  /**
   * Wait for the VM to get an IP address from its guest agent, polling every
   * 2 seconds for up to 5 minutes.
   *
   * A status request that fails for a reason asking again cannot fix, like an
   * expired session, ends the wait right away with that error.
   */
  private async _waitForVmIp(
    session: ProxmoxSession,
    { node, vm_id }: ProxmoxVmResult,
    signal: AbortSignal
  ): Promise<string> {
    return pollUntil(
      async () => (await proxmoxGetVmStatus(session, node, vm_id)).ip_address,
      {
        interval: POLL_INTERVAL_MS,
        timeout: VM_IP_TIMEOUT_MS,
        signal,
        timeoutMessage: localize(
          "views.proxmox.proxmox_progress_view.the_virtual_machine_did_not_report_an_ip_address"
        ),
        stopOn: needsUserAction,
      }
    );
  }

  /**
   * Wait for the Home Assistant webserver to be ready on port 80, polling
   * every 2 seconds for up to 5 minutes.
   */
  private async _waitForHaReady(
    ipAddress: string,
    signal: AbortSignal
  ): Promise<void> {
    await pollUntil(async () => (await checkHaReady(ipAddress)) || null, {
      interval: POLL_INTERVAL_MS,
      timeout: HA_READY_TIMEOUT_MS,
      signal,
      timeoutMessage: localize(
        "views.proxmox.proxmox_progress_view.home_assistant_did_not_respond_at_value_within_5_minutes",
        { value0: ipAddress }
      ),
    });
  }

  /**
   * Wait for Home Assistant to finish updating to the latest version, which
   * is when it starts serving `manifest.json`. Polls every 2 seconds for up
   * to 1 hour.
   */
  private async _waitForHaUpdated(
    ipAddress: string,
    signal: AbortSignal
  ): Promise<void> {
    await pollUntil(async () => (await checkHaUpdated(ipAddress)) || null, {
      interval: POLL_INTERVAL_MS,
      timeout: HA_UPDATED_TIMEOUT_MS,
      signal,
      timeoutMessage: localize(
        "views.proxmox.proxmox_progress_view.update_timeout",
        { address: `http://${ipAddress}` }
      ),
    });
  }

  /** Show an error and tell the shell whether a retry is safe. */
  private _setError(error: unknown) {
    this._diagnostics?.fail(error);
    this._stage = "error";
    this._error = installerError(
      error,
      localize(
        "views.proxmox.proxmox_progress_view.failed_to_create_virtual_machine"
      )
    );
    this.dispatchEvent(
      new CustomEvent("install-error", {
        detail: { retryable: this._error.retryable },
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
        .stageTitle=${this._getStageTitle(stage)}
        .description=${this._getStageDescription(stage)}
        .progress=${this._progress}
        .bytesProcessed=${this._bytesProcessed}
        .totalBytes=${this._totalBytes}
        .stageStartTime=${this._stageStartTime}
        .stageStartBytes=${this._stageStartBytes}
        .indeterminate=${this._isIndeterminate(stage)}
        .measurable=${this._hasMeasurableProgress(stage)}
        .error=${this._error?.message ?? null}
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
