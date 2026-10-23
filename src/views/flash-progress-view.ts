import { localize } from "../localization/localize.js";
import { html, nothing, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import type { FlashProgress, FlashStage } from "../api/index.js";
import "../components/install-progress.js";
import { InstallProgressView } from "./install-progress-view.js";

/** Stages in which the write has reached the drive */
const ON_THE_DRIVE: readonly FlashStage[] = [
  "writing",
  "verifying",
  "finalizing",
];

/**
 * An install that writes a drive: flashing an SD card or USB drive, and making
 * the live USB stick or its ISO. Keeps the backend's progress, whether the
 * write reached the drive, and how long the current stage has run, and shows
 * them. Each flow says which stages it has and what they are called.
 */
export abstract class FlashProgressView extends InstallProgressView {
  @state()
  protected _progress: FlashProgress | null = null;

  /** Whether this attempt got as far as the drive. */
  protected _reachedDrive = false;

  /** The stages this install goes through, in order. */
  protected abstract _stages(): readonly FlashStage[];

  protected abstract _stageTitle(stage: FlashStage): string;

  protected abstract _stageDescription(stage: FlashStage): string;

  /** Shown with the progress, like a reminder to leave the stick in. */
  protected _renderNote(): TemplateResult | typeof nothing {
    return nothing;
  }

  protected _resetProgress() {
    this._progress = null;
    this._reachedDrive = false;
  }

  /** Take in one progress update from the backend. */
  protected _onProgress(progress: FlashProgress) {
    this._diagnostics?.advance(progress.stage);
    const previous = this._progress;
    // Time left is measured per stage. A stage can also cover several files
    // one after another (the live USB downloads two), so a new total or a
    // count that starts over starts the clock again too.
    if (
      previous?.stage !== progress.stage ||
      previous.total_bytes !== progress.total_bytes ||
      progress.bytes_processed < previous.bytes_processed
    ) {
      this._stageStartTime = Date.now();
      this._stageStartBytes = progress.bytes_processed;
    }
    if (ON_THE_DRIVE.includes(progress.stage)) this._reachedDrive = true;
    this._progress = progress;
  }

  render() {
    const stage = this._progress?.stage || "downloading";
    return html`
      <install-progress
        .stages=${this._stages().map((id) => ({
          id,
          label: this._stageDescription(id),
        }))}
        .stage=${stage}
        .stageTitle=${this._stopping
          ? localize("common.install.stopping")
          : this._stageTitle(stage)}
        .description=${this._stageDescription(stage)}
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
        ${this._renderNote()}
      </install-progress>
    `;
  }
}
