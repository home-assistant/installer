import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { flashImage, type FlashProgress } from "../../api/index.js";
import { readDriveSelection } from "../../utils/drive-selection.js";
import "../../components/install-progress.js";

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
  private _error: string | null = null;

  @state()
  private _isFlashing = false;

  private _stageStartTime: number | null = null;
  private _stageStartBytes: number = 0;

  /** Whether the flash operation has failed */
  get hasError(): boolean {
    return this._error !== null;
  }

  /** Retry the flash operation */
  retry(): void {
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
    this._error = null;

    const selections = this._wizardState.selections;
    const drive = readDriveSelection(selections);
    const deviceConfig = selections.deviceConfig;

    if (!drive || !deviceConfig) {
      this._isFlashing = false;
      this._setError("Missing drive or device configuration");
      return;
    }

    try {
      const result = await flashImage(
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
          },
        },
        (progress) => {
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

      if (!result.success) {
        this._setError(result.error || "Flash failed");
      }
    } catch (err) {
      // Tauri invoke errors come as strings, not Error objects
      const errorMessage =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "An unexpected error occurred";
      this._setError(errorMessage);
    } finally {
      this._isFlashing = false;
    }
  }

  private _setError(message: string) {
    // Provide user-friendly messages for specific error types
    if (message.toLowerCase().includes("disconnected")) {
      this._error =
        "The storage device was disconnected during the installation. Please reconnect it and try again.";
    } else {
      this._error = message;
    }
    this.dispatchEvent(
      new CustomEvent("flash-error", {
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
        .error=${this._error}
      ></install-progress>
    `;
  }

  private _getStageTitle(stage: string): string {
    switch (stage) {
      case "downloading":
        return "Downloading";
      case "extracting":
        return "Extracting";
      case "writing":
        return "Writing";
      case "verifying":
        return "Verifying";
      case "finalizing":
        return "Finalizing";
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
        return "Fetching the Home Assistant image";
      case "extracting":
        return "Extracting the image";
      case "writing":
        return "Writing Home Assistant to your drive";
      case "verifying":
        return "Verifying the written data";
      case "finalizing":
        return "Finishing up the installation";
      case "complete":
        return "Installation complete!";
      default:
        return "Installing Home Assistant";
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "progress-view": ProgressView;
  }
}
