import { localize } from "../../localization/localize.js";
import { html, css, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { wizardState } from "../../state/wizard-state.js";
import {
  cancelLiveUsb,
  createLiveUsb,
  saveLiveIso,
  type FlashProgress,
  type FlashStage,
} from "../../api/index.js";
import { readDriveSelection } from "../../utils/drive-selection.js";
import {
  isDriveFailure,
  type InstallerError,
} from "../../utils/installer-error.js";
import { throwIfCancelled } from "../../utils/polling.js";
import { FlashProgressView } from "../flash-progress-view.js";

/**
 * Failures of the ISO's folder or file name, which another location fixes.
 * The ISO is built in its folder, so a read or write error is most likely
 * there too.
 */
const LOCATION_FAILURES = [
  "file_exists",
  "file_name_not_portable",
  "folder_in_cache",
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
export class LiveUsbProgressView extends FlashProgressView {
  static styles = [
    FlashProgressView.styles,
    css`
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
    `,
  ];

  protected readonly _flow = "flash";

  protected _cancel(attempt: string): Promise<void> {
    return cancelLiveUsb(attempt);
  }

  protected _stages(): readonly FlashStage[] {
    return this._usb
      ? ["downloading", "extracting", "writing", "verifying", "finalizing"]
      : ["downloading", "extracting"];
  }

  private get _usb(): boolean {
    return wizardState.getState().selections.liveMedia !== "iso";
  }

  protected async _install(signal: AbortSignal) {
    const selections = wizardState.getState().selections;
    const onProgress = (progress: FlashProgress) => this._onProgress(progress);

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

  /** The stick is being written: pulling it out now leaves it unusable */
  protected _renderNote() {
    return this._usb && !this._error
      ? html`<p class="keep-plugged-in">
          ${localize("views.live_usb.live_usb_progress_view.do_not_remove")}
        </p>`
      : nothing;
  }

  protected _stageTitle(stage: FlashStage): string {
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

  protected _stageDescription(stage: FlashStage): string {
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
