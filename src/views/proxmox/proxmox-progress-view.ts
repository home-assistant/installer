import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { proxmoxCreateVm } from "../../api/commands.js";
import type { FlashProgress, ProxmoxVmConfig } from "../../api/types.js";
import {
  DEFAULT_CPU_CORES,
  DEFAULT_DISK_SIZE_GB,
  DEFAULT_MEMORY_MB,
  DEFAULT_PROXMOX_NODE,
  DEFAULT_PROXMOX_STORAGE,
  DEFAULT_PROXMOX_VM_ID,
  DEFAULT_PROXMOX_VM_NAME,
} from "../../state/vm-defaults.js";
import { isCancelled, throwIfCancelled } from "../../utils/polling.js";
import "../../components/install-progress.js";

type InstallStage =
  | "downloading"
  | "extracting"
  | "writing"
  | "verifying"
  | "finalizing"
  | "ready"
  | "updating"
  | "complete"
  | "error";

// Stages that have measurable progress (0-100%)
const MEASURABLE_STAGES: InstallStage[] = [
  "downloading",
  "extracting",
  "writing",
];

// Stages that use indeterminate progress (waiting for something, or unknown total size)
const INDETERMINATE_STAGES: InstallStage[] = [
  "extracting",
  "writing",
  "verifying",
  "finalizing",
  "ready",
  "updating",
];

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
  private _error: string | null = null;

  @state()
  private _isInstalling = false;

  private _stageStartTime: number | null = null;
  private _stageStartBytes: number = 0;
  private _unsubscribe?: () => void;
  private _abortController?: AbortController;

  /** Whether the install operation has failed */
  get hasError(): boolean {
    return this._error !== null;
  }

  /** Retry the install operation */
  retry(): void {
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

    const selections = this._wizardState.selections;
    const session = selections.proxmoxSession;

    if (!session) {
      this._setError("No Proxmox session available");
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
      vm_id: selections.proxmoxVmId ?? DEFAULT_PROXMOX_VM_ID,
      name: selections.vmName || DEFAULT_PROXMOX_VM_NAME,
      cpu_cores: selections.cpuCores ?? DEFAULT_CPU_CORES,
      memory_mb: selections.memoryMb ?? DEFAULT_MEMORY_MB,
      disk_size_gb: selections.diskSizeGb ?? DEFAULT_DISK_SIZE_GB,
      auto_start: true,
    };

    try {
      this._stage = "downloading";
      this._stageStartTime = Date.now();
      this._stageStartBytes = 0;

      const result = await proxmoxCreateVm(
        session,
        config,
        (progress: FlashProgress) => {
          // Progress keeps arriving from the backend after a cancel; a
          // detached view must stop reporting on it
          if (signal.aborted) return;

          // Use raw per-stage progress
          const newStage = progress.stage as InstallStage;
          if (newStage !== this._stage) {
            this._stage = newStage;
            this._stageStartTime = Date.now();
            this._stageStartBytes = progress.bytes_processed;
          }

          this._progress = progress.progress;
          this._bytesProcessed = progress.bytes_processed;
          this._totalBytes = progress.total_bytes;
        }
      );

      throwIfCancelled(signal);

      // Store result in wizard state
      wizardState.setSelection("proxmoxVmResult", result);
      if (result.ip_address) {
        wizardState.setSelection("ipAddress", result.ip_address);
      }

      // Complete
      this._stage = "complete";
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
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : "Failed to create virtual machine"
      );
    } finally {
      // A newer attempt may own the component by now (cancel, then retry)
      if (this._abortController === controller) {
        this._isInstalling = false;
        this._abortController = undefined;
      }
    }
  }

  /** Show an error, and tell the app shell so it shows Cancel and Try again. */
  private _setError(message: string) {
    this._stage = "error";
    this._error = message;
    this.dispatchEvent(
      new CustomEvent("install-error", {
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
          "writing",
          "verifying",
          "finalizing",
          "ready",
          "updating",
        ].map((id) => ({
          id,
          label:
            id === "updating"
              ? "Installing latest Home Assistant"
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
        .error=${this._error}
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
        return "Downloading";
      case "extracting":
        return "Uploading";
      case "writing":
        return "Creating";
      case "verifying":
        return "Starting";
      case "finalizing":
        return "Connecting";
      case "ready":
        return "Waiting";
      case "updating":
        return "Updating";
      case "complete":
        return "Complete!";
      case "error":
        return "Error";
      default:
        return "Installing";
    }
  }

  private _getStageDescription(stage: string): string {
    switch (stage) {
      case "downloading":
        return "Downloading Home Assistant OS";
      case "extracting":
        return "Uploading image to Proxmox";
      case "writing":
        return "Creating virtual machine";
      case "verifying":
        return "Starting Home Assistant OS";
      case "finalizing":
        return "Waiting for network connection";
      case "ready":
        return "Waiting for Home Assistant";
      case "updating":
        return "Installing latest Home Assistant (this can take up to 20 minutes)";
      case "complete":
        return "Installation complete!";
      default:
        return "Installing Home Assistant";
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "proxmox-progress-view": ProxmoxProgressView;
  }
}
