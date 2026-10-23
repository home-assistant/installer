import { html } from "lit";
import { state } from "lit/decorators.js";
import { cancelVmInstall } from "../api/commands.js";
import type { FlashProgress } from "../api/types.js";
import { localize } from "../localization/localize.js";
import {
  haSetupProblemMessage,
  type HaSetupProgress,
} from "../utils/ha-setup.js";
import {
  installerError,
  type InstallerError,
} from "../utils/installer-error.js";
import {
  WAIT_STAGES,
  checkedAddress,
  isWaitStage,
  waitError,
  waitForHomeAssistant,
  waitStageDescription,
  waitStageTitle,
  type HomeAssistantWait,
  type WaitStage,
} from "../utils/vm-wait.js";
import "../components/install-progress.js";
import { InstallProgressView } from "./install-progress-view.js";

/** A flow's own stages from the download on, then the waits, then the end */
export type VmInstallStage<Stage extends string> =
  | "downloading"
  | Stage
  | WaitStage
  | "complete"
  | "error";

/**
 * What the UTM and Proxmox install views share. Each runs its own steps up
 * to a running VM. This shows them and the waits for Home Assistant that
 * follow: a stop can end the install only until the VM is made, and the user
 * can leave once it runs.
 */
export abstract class VmProgressView<
  Stage extends string,
> extends InstallProgressView {
  @state()
  protected _stage: VmInstallStage<Stage> = "downloading";

  @state()
  protected _progress = 0;

  @state()
  protected _bytesProcessed = 0;

  @state()
  protected _totalBytes = 0;

  /** What Supervisor reports while it installs Home Assistant */
  @state()
  protected _setup: HaSetupProgress = { progress: null, problem: null };

  /** The flow's own stages, in order; the waits follow them */
  protected abstract readonly _stages: readonly ("downloading" | Stage)[];

  /** The stages a stop can still end without leaving anything behind */
  protected abstract readonly _stoppableStages: readonly VmInstallStage<Stage>[];

  /** The stages that report how far they are (0-100%) */
  protected abstract readonly _measurableStages: readonly VmInstallStage<Stage>[];

  /** Whether the user can leave with the VM running and nothing left to start */
  get leavable(): boolean {
    // The VM runs and only Home Assistant is awaited, so leaving loses
    // nothing. A VM that exists but was never started would stay stopped.
    return this._error === null && isWaitStage(this._stage);
  }

  /** Whether `stop` can still end the install without leaving anything behind */
  get stoppable(): boolean {
    return super.stoppable && this._atStoppableStage;
  }

  /**
   * Whether the install is at one of `_stoppableStages`. Unlike `stoppable`,
   * this holds between steps too, like right after one failed.
   */
  protected get _atStoppableStage(): boolean {
    return this._stoppableStages.includes(this._stage);
  }

  protected _cancel(attempt: string): Promise<void> {
    return cancelVmInstall(attempt);
  }

  protected _resetProgress() {
    this._stage = "downloading";
    this._clearProgress();
  }

  /**
   * Forget how far the step before got, so its percent, byte counts and
   * Supervisor report are not shown next to the one that starts.
   */
  private _clearProgress() {
    this._progress = 0;
    this._bytesProcessed = 0;
    this._totalBytes = 0;
    this._setup = { progress: null, problem: null };
  }

  protected _installerError(error: unknown): InstallerError {
    return installerError(
      error,
      localize("common.vm.failed_to_create_virtual_machine")
    );
  }

  protected _complete() {
    this._stage = "complete";
    this._progress = 100;
    super._complete();
  }

  /**
   * Run the backend step a stop can end, from the download on. `step` starts
   * it under the name `stop` asks to end.
   */
  protected _runBackendStep<T>(
    step: (attempt: string) => Promise<T>
  ): Promise<T> {
    this._diagnostics?.advance("downloading");
    this._stage = "downloading";
    this._clearProgress();
    this._stageStartTime = Date.now();
    this._stageStartBytes = 0;
    return this._runStoppable(step);
  }

  /** Show what the backend reports, moving on to `stage` when it is new */
  protected _showProgress(
    stage: VmInstallStage<Stage>,
    progress: FlashProgress
  ) {
    if (stage !== this._stage) {
      this._diagnostics?.advance(stage);
      this._stage = stage;
      this._stageStartTime = Date.now();
      this._stageStartBytes = progress.bytes_processed;
    }

    // In whole percent: the layout shows every digit it gets
    this._progress = Math.round(progress.progress);
    this._bytesProcessed = progress.bytes_processed;
    this._totalBytes = progress.total_bytes;
  }

  /** Move to an indeterminate stage, clearing the previous stage's progress */
  protected _startStage(stage: VmInstallStage<Stage>) {
    this._diagnostics?.advance(stage);
    this._stage = stage;
    this._clearProgress();
    this._stageStartTime = null;
  }

  /** Wait for Home Assistant on the running VM, and return its address */
  protected _waitForHomeAssistant(
    wait: Pick<HomeAssistantWait, "vmAddress" | "stopOn" | "messages">,
    signal: AbortSignal
  ): Promise<string> {
    return waitForHomeAssistant({
      ...wait,
      onStage: (stage) => this._startStage(stage),
      onSetup: (setup) => {
        this._setup = setup;
        this._progress = Math.round(setup.progress ?? 0);
      },
      signal,
    });
  }

  protected _fail(
    error: unknown,
    message?: string,
    detail: Record<string, unknown> = {}
  ) {
    this._stage = "error";
    // Log a wait that ran out as a timeout, not by the words of its message
    super._fail(waitError(error), message, detail);
  }

  render() {
    const stage = this._stage;
    return html`
      <install-progress
        .stages=${[...this._stages, ...WAIT_STAGES].map((id) => ({
          id,
          label:
            id === "updating"
              ? localize("common.vm.installing_latest_home_assistant")
              : this._getStageDescription(id),
        }))}
        .stage=${stage}
        .stageTitle=${this._stopping
          ? localize("common.install.stopping")
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

  /** Check if a stage uses indeterminate progress */
  private _isIndeterminate(stage: VmInstallStage<Stage>): boolean {
    // Every stage before the end waits for something, unless it can measure
    return (
      stage !== "complete" &&
      stage !== "error" &&
      !this._hasMeasurableProgress(stage)
    );
  }

  /** Check if a stage has measurable progress (0-100%) */
  private _hasMeasurableProgress(stage: VmInstallStage<Stage>): boolean {
    // Once Supervisor reports downloading Core
    if (stage === "updating") return this._setup.progress !== null;
    return (
      this._measurableStages.includes(stage) &&
      (stage === "downloading" || this._totalBytes > 0)
    );
  }

  private _getStageTitle(stage: VmInstallStage<Stage>): string {
    if (stage === "complete") {
      return localize("common.install.complete");
    }
    if (stage === "error") return localize("common.error");
    return isWaitStage(stage) ? waitStageTitle(stage) : this._stageTitle(stage);
  }

  private _getStageDescription(stage: VmInstallStage<Stage>): string {
    if (stage === "complete") {
      return localize("common.install.installation_complete");
    }
    // The layout shows the error instead
    if (stage === "error") {
      return localize("common.install.installing_home_assistant");
    }
    return isWaitStage(stage)
      ? waitStageDescription(stage)
      : this._stageDescription(stage);
  }

  /**
   * A title for one of the flow's own stages, like the waits have theirs.
   * These are the stages both flows have; a flow adds the ones only it has.
   */
  protected _stageTitle(stage: "downloading" | Stage): string {
    switch (stage) {
      case "downloading":
        return localize("common.install.downloading");
      case "extracting":
        return localize("common.install.extracting");
      // UTM names its own stages; Proxmox's come from the backend
      case "creating":
      case "creating_vm":
        return localize("common.vm.creating");
      case "starting":
      case "starting_vm":
        return localize("common.vm.starting");
      default:
        return localize("common.install.installing");
    }
  }

  protected _stageDescription(stage: "downloading" | Stage): string {
    switch (stage) {
      case "downloading":
        return localize("common.vm.downloading_home_assistant_os");
      case "extracting":
        return localize("common.install.extracting_the_image");
      case "creating":
      case "creating_vm":
        return localize("common.vm.creating_virtual_machine");
      case "starting":
      case "starting_vm":
        return localize("common.vm.starting_home_assistant_os");
      default:
        return localize("common.install.installing_home_assistant");
    }
  }
}
