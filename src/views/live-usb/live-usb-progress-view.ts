import { localize } from "../../localization/localize.js";
import { html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { wizardState } from "../../state/wizard-state.js";
import {
  cancelLiveUsb,
  createLiveUsb,
  saveLiveIso,
  type FlashProgress,
} from "../../api/index.js";
import { readDriveSelection } from "../../utils/drive-selection.js";
import {
  isDriveFailure,
  type InstallerError,
} from "../../utils/installer-error.js";
import { throwIfCancelled } from "../../utils/polling.js";
import "../../components/install-progress.js";
import { InstallProgressView } from "../install-progress-view.js";

/**
 * Failures of the ISO's folder or file name, which another location fixes.
 * The ISO is built in its folder, so a read or write error is most likely
 * there too.
 */
const LOCATION_FAILURES = [
  "file_exists",
  "folder_name_taken",
  "folder_not_found",
  "invalid_file_name",
  "io",
];

/**
 * Creates the stick or ISO, as the install of the Mini PC's USB boot steps.
 * The shell stops it, retries it and goes back from it like any install.
 */
@customElement("live-usb-progress-view")
export class LiveUsbProgressView extends InstallProgressView {
  static styles = css`
    :host {
      display: block;
      height: 100%;
    }
    install-progress {
      width: 100%;
    }
    .keep-plugged-in {
      margin: 0 auto 1rem;
      max-width: 500px;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      text-align: center;
      font-weight: 500;
      color: var(--ha-error-color, #db4437);
      background-color: rgba(219, 68, 55, 0.1);
      border: 1px solid rgba(219, 68, 55, 0.3);
    }
  `;

  protected readonly _flow = "flash";

  @state()
  private _progress: FlashProgress | null = null;

  /** Whether this attempt got as far as the stick. */
  private _reachedDrive = false;

  protected _cancel(attempt: string): Promise<void> {
    return cancelLiveUsb(attempt);
  }

  protected _resetProgress() {
    this._progress = null;
  }

  private get _usb(): boolean {
    return wizardState.getState().selections.liveMedia !== "iso";
  }

  protected async _install(signal: AbortSignal) {
    this._reachedDrive = false;
    const selections = wizardState.getState().selections;
    const onProgress = (progress: FlashProgress) => {
      this._diagnostics?.advance(progress.stage);
      const previous = this._progress;
      // The download stage covers two files; time each one on its own.
      if (
        previous?.stage !== progress.stage ||
        previous.total_bytes !== progress.total_bytes ||
        progress.bytes_processed < previous.bytes_processed
      ) {
        this._stageStartTime = Date.now();
        this._stageStartBytes = progress.bytes_processed;
      }
      if (["writing", "verifying", "finalizing"].includes(progress.stage)) {
        this._reachedDrive = true;
      }
      this._progress = progress;
    };

    if (this._usb) {
      const drive = readDriveSelection(selections);
      if (!drive) {
        throw new Error(
          localize("views.live_usb.live_usb_progress_view.no_stick_selected")
        );
      }
      await this._runStoppable((attempt) =>
        createLiveUsb(
          drive.id,
          {
            size: drive.size,
            model: drive.model,
            vendor: drive.vendor,
            serial: drive.serial,
          },
          onProgress,
          attempt
        )
      );
    } else {
      const path = await this._runStoppable((attempt) =>
        saveLiveIso(
          selections.liveIsoFolder ?? "",
          selections.liveIsoName ?? "",
          selections.liveIsoOverwrite === true,
          onProgress,
          attempt
        )
      );
      // A run left behind (the view detached, or a new flow started) must
      // not write into the wizard state
      throwIfCancelled(signal);
      wizardState.setSelection("liveIsoPath", path);
    }
    return {};
  }

  protected _choiceCanFix(error: InstallerError): boolean {
    return this._usb
      ? isDriveFailure(error.code, this._reachedDrive)
      : LOCATION_FAILURES.includes(error.code);
  }

  protected _stoppedMessage(): string {
    if (!this._usb) {
      return localize("views.live_usb.live_usb_progress_view.stopped_no_iso");
    }
    return this._reachedDrive
      ? localize(
          "views.live_usb.live_usb_progress_view.stopped_stick_not_ready"
        )
      : localize(
          "views.live_usb.live_usb_progress_view.stopped_nothing_written"
        );
  }

  render() {
    const stages = this._usb
      ? ["downloading", "extracting", "writing", "verifying", "finalizing"]
      : ["downloading", "extracting"];
    const stage = this._progress?.stage || "downloading";
    return html`
      <install-progress
        .stages=${stages.map((id) => ({ id, label: this._describe(id) }))}
        .stage=${stage}
        .stageTitle=${this._title(stage)}
        .description=${this._describe(stage)}
        .progress=${this._progress?.progress || 0}
        .bytesProcessed=${this._progress?.bytes_processed || 0}
        .totalBytes=${this._progress?.total_bytes || 0}
        .stageStartTime=${this._stageStartTime}
        .stageStartBytes=${this._stageStartBytes}
        .indeterminate=${!this._progress?.total_bytes && stage !== "complete"}
        .measurable=${!!this._progress?.total_bytes || stage === "complete"}
        .showUnknownBytes=${true}
        .error=${this._error?.message ?? null}
      >
        ${this._usb && !this._error
          ? html`<p class="keep-plugged-in">
              ${localize("views.live_usb.live_usb_progress_view.do_not_remove")}
            </p>`
          : ""}
      </install-progress>
    `;
  }

  private _title(stage: string): string {
    switch (stage) {
      case "downloading":
        return localize("common.install.downloading");
      case "extracting":
        return this._usb
          ? localize("views.live_usb.live_usb_progress_view.preparing")
          : localize("views.live_usb.live_usb_progress_view.building");
      case "writing":
        return localize("views.live_usb.live_usb_progress_view.writing");
      case "verifying":
        return localize("views.live_usb.live_usb_progress_view.verifying");
      case "finalizing":
        return localize("views.live_usb.live_usb_progress_view.finalizing");
      case "complete":
        return localize("common.install.complete");
      default:
        return localize("common.error");
    }
  }

  private _describe(stage: string): string {
    switch (stage) {
      case "downloading":
        return this._usb
          ? localize("views.live_usb.live_usb_progress_view.downloading_usb")
          : localize("views.live_usb.live_usb_progress_view.downloading_iso");
      case "extracting":
        return this._usb
          ? localize(
              "views.live_usb.live_usb_progress_view.preparing_description"
            )
          : localize(
              "views.live_usb.live_usb_progress_view.building_description"
            );
      case "writing":
        return localize(
          "views.live_usb.live_usb_progress_view.writing_description"
        );
      case "verifying":
        return localize(
          "views.live_usb.live_usb_progress_view.verifying_the_written_data"
        );
      case "finalizing":
        return localize(
          "views.live_usb.live_usb_progress_view.finalizing_description"
        );
      default:
        return localize("views.live_usb.live_usb_progress_view.creating");
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "live-usb-progress-view": LiveUsbProgressView;
  }
}
