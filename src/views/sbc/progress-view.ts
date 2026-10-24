import { localize } from "../../localization/localize.js";
import {
  installerError,
  isDriveFailure,
  retryableOnceFixed,
  type InstallerError,
} from "../../utils/installer-error.js";
import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  cancelFlash,
  flashImage,
  type FlashProgress,
  type FlashStage,
} from "../../api/index.js";
import { readDriveSelection } from "../../utils/drive-selection.js";
import { selectedWifi } from "../../utils/wifi.js";
import { findInstaller } from "../../state/ha-hardware.js";
import "../../components/install-progress.js";
import { InstallProgressView } from "../install-progress-view.js";

/** The stages a flash goes through, in order */
const STAGES: readonly FlashStage[] = [
  "downloading",
  "extracting",
  "writing",
  "verifying",
  "finalizing",
];

/** Why a flash cannot start: an earlier step left no drive or board */
function missingTarget(): Error {
  return new Error(
    localize("views.sbc.progress_view.missing_drive_or_device_configuration")
  );
}

@customElement("progress-view")
export class ProgressView extends InstallProgressView {
  protected readonly _flow = "flash";

  @state()
  private _progress: FlashProgress | null = null;

  /** Whether this attempt got as far as the drive. */
  private _reachedDrive = false;

  protected _cancel(attempt: string): Promise<void> {
    return cancelFlash(attempt);
  }

  protected _resetProgress() {
    this._progress = null;
  }

  protected _startFailure() {
    const selections = this._wizardState.selections;
    if (readDriveSelection(selections) && selections.deviceConfig) {
      return undefined;
    }
    return { error: missingTarget() };
  }

  protected async _install() {
    this._reachedDrive = false;
    const selections = this._wizardState.selections;
    const drive = readDriveSelection(selections);
    const deviceConfig = selections.deviceConfig;
    // `_startFailure` holds back a flash without them; should one go missing
    // anyway, it fails the same way
    if (!drive || !deviceConfig) throw missingTarget();

    await this._runStoppable((attempt) =>
      flashImage(
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
          wifi: selectedWifi(selections) ?? null,
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
          if (["writing", "verifying", "finalizing"].includes(progress.stage)) {
            this._reachedDrive = true;
          }
        },
        attempt
      )
    );
  }

  protected _installerError(error: unknown): InstallerError {
    return retryableOnceFixed(installerError(error));
  }

  // Only what is wrong with the drive leads back to the drive step. Space on
  // this computer or an unexpected response can't be fixed there.
  protected _choiceCanFix(error: InstallerError): boolean {
    return isDriveFailure(error.code, this._reachedDrive);
  }

  protected _stoppedMessage(): string {
    if (this._reachedDrive) {
      return localize("views.sbc.progress_view.stopped_drive_not_ready");
    }
    return localize("views.sbc.progress_view.stopped_nothing_written");
  }

  render() {
    const stage = this._progress?.stage || "downloading";
    return html`
      <install-progress
        .stages=${STAGES.map((id) => ({
          id,
          label: this._getStageDescription(id),
        }))}
        .stage=${stage}
        .stageTitle=${this._stopping
          ? localize("common.install.stopping")
          : this._getStageTitle(stage)}
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

  private _getStageTitle(stage: FlashStage): string {
    switch (stage) {
      case "downloading":
        return localize("common.install.downloading");
      case "extracting":
        return localize("common.install.extracting");
      case "writing":
        return localize("views.sbc.progress_view.writing");
      case "verifying":
        return localize("views.sbc.progress_view.verifying");
      case "finalizing":
        return localize("views.sbc.progress_view.finalizing");
      case "complete":
        return localize("common.install.complete");
      case "error":
        return localize("common.error");
      default:
        return localize("common.install.installing");
    }
  }

  private _getStageDescription(stage: FlashStage): string {
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
        return localize("common.install.extracting_the_image");
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
        return localize("common.install.installation_complete");
      default:
        return localize("common.install.installing_home_assistant");
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "progress-view": ProgressView;
  }
}
