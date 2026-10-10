import { localize } from "../../localization/localize.js";
import {
  installerError,
  type InstallerError,
} from "../../utils/installer-error.js";
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { flashImage, type FlashProgress } from "../../api/index.js";
import { readDriveSelection } from "../../utils/drive-selection.js";
import { findInstaller } from "../ha-hardware/hardware.js";
import "../../components/install-progress.js";
import "../../components/progress-bar.js";
import { InstallDiagnostics } from "../../utils/diagnostics.js";

@customElement("progress-view")
export class ProgressView extends LitElement {
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
  private _progress: FlashProgress | null = null;

  @state()
  private _error: InstallerError | null = null;

  @state()
  private _isFlashing = false;

  private _stageStartTime: number | null = null;
  private _diagnostics?: InstallDiagnostics;
  private _stageStartBytes: number = 0;

  /** Whether the flash operation has failed */
  get hasError(): boolean {
    return this._error !== null;
  }

  /** Retry the flash operation */
  retry(): void {
    if (!this._error?.retryable) return;
    this._error = null;
    this._progress = null;
    this._stageStartTime = null;
    this._stageStartBytes = 0;
    void this._startFlashing();
  }

  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = wizardState.subscribe((state) => {
      this._wizardState = state;
    });

    // Start flashing when view is connected
    void this._startFlashing();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  private async _startFlashing() {
    if (this._isFlashing) return;

    this._isFlashing = true;
    this._diagnostics = new InstallDiagnostics("flash");
    this._error = null;

    const selections = this._wizardState.selections;
    const drive = readDriveSelection(selections);
    const deviceConfig = selections.deviceConfig;

    if (!drive || !deviceConfig) {
      this._isFlashing = false;
      this._setError(
        localize(
          "views.sbc.progress_view.missing_drive_or_device_configuration"
        )
      );
      return;
    }

    try {
      await flashImage(
        {
          device_id: drive.id,
          board: deviceConfig.board,
          verify: true,
          // The download before the write can take minutes; the backend
          // re-checks this right before writing.
          expected_device: {
            size: drive.size,
            model: drive.model,
            vendor: drive.vendor,
            serial: drive.serial,
          },
        },
        (progress) => {
          this._diagnostics?.advance(progress.stage);
          // Track stage changes for ETA calculation
          const prevStage = this._progress?.stage;
          if (prevStage !== progress.stage) {
            this._stageStartTime = Date.now();
            this._stageStartBytes = progress.bytes_processed;
          }

          this._progress = progress;

          // If we've completed, advance to next step
          if (progress.stage === "complete") {
            this._onComplete();
          }
        }
      );
    } catch (err) {
      this._setError(err);
    } finally {
      this._isFlashing = false;
    }
  }

  private _setError(error: unknown) {
    this._diagnostics?.fail(error);
    this._error = installerError(error);
    this.dispatchEvent(
      new CustomEvent("flash-error", {
        detail: { retryable: this._error.retryable },
        bubbles: true,
        composed: true,
      })
    );
  }

  private _onComplete() {
    // Dispatch event to notify parent
    this.dispatchEvent(
      new CustomEvent("flash-complete", {
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    const stage = this._progress?.stage || "downloading";
    return html`
      <install-progress
        .stages=${[
          "downloading",
          "extracting",
          "writing",
          "verifying",
          "finalizing",
        ].map((id) => ({ id, label: this._getStageDescription(id) }))}
        .stage=${stage}
        .stageTitle=${this._getStageTitle(stage)}
        .description=${this._getStageDescription(stage)}
        .progress=${this._progress?.progress || 0}
        .bytesProcessed=${this._progress?.bytes_processed || 0}
        .totalBytes=${this._progress?.total_bytes || 0}
        .stageStartTime=${this._stageStartTime}
        .stageStartBytes=${this._stageStartBytes}
        .indeterminate=${!this._progress?.total_bytes && stage !== "complete"}
        .measurable=${!!this._progress?.total_bytes || stage === "complete"}
        .showUnknownBytes=${true}
        .error=${this._error?.message ?? null}
      ></install-progress>
    `;
  }

  private _getStageTitle(stage: string): string {
    switch (stage) {
      case "downloading":
        return localize("views.proxmox.proxmox_progress_view.downloading");
      case "extracting":
        return localize("views.sbc.progress_view.extracting");
      case "writing":
        return localize("views.sbc.progress_view.writing");
      case "verifying":
        return localize("views.sbc.progress_view.verifying");
      case "finalizing":
        return localize("views.sbc.progress_view.finalizing");
      case "complete":
        return localize("views.proxmox.proxmox_progress_view.complete");
      case "error":
        return localize("common.error");
      default:
        return localize("views.proxmox.proxmox_progress_view.installing");
    }
  }

  private _getStageDescription(stage: string): string {
    const installer = !!findInstaller(
      this._wizardState.selections.deviceConfig?.board
    );
    switch (stage) {
      case "downloading":
        return installer
          ? localize("views.sbc.progress_view.fetching_the_installer_image")
          : localize(
              "views.sbc.progress_view.fetching_the_home_assistant_image"
            );
      case "extracting":
        return localize("views.sbc.progress_view.extracting_the_image");
      case "writing":
        return installer
          ? localize(
              "views.sbc.progress_view.writing_the_installer_to_your_drive"
            )
          : localize(
              "views.sbc.progress_view.writing_home_assistant_to_your_drive"
            );
      case "verifying":
        return localize("views.sbc.progress_view.verifying_the_written_data");
      case "finalizing":
        return localize(
          "views.sbc.progress_view.finishing_up_the_installation"
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
    "progress-view": ProgressView;
  }
}
