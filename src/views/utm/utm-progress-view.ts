import {
  installerError,
  type InstallerError,
} from "../../utils/installer-error.js";
import { LitElement, html, css } from "lit";
import { localize } from "../../localization/localize.js";
import {
  InstallDiagnostics,
  logFrontendError,
} from "../../utils/diagnostics.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import {
  downloadUtmImage,
  discardUtmImage,
  createUtmVm,
  resizeUtmVmDisk,
  startUtmVm,
  getUtmVmStatus,
  checkHaReady,
  checkHaUpdated,
  type VmStatusInfo,
} from "../../api/commands.js";
import type { FlashProgress, UtmVmConfig } from "../../api/types.js";
import {
  DEFAULT_CPU_CORES,
  DEFAULT_DISK_SIZE_GB,
  DEFAULT_MEMORY_MB,
  DEFAULT_UTM_VM_NAME,
} from "../../state/vm-defaults.js";
import {
  PollTimeoutError,
  isCancelled,
  pollUntil,
  throwIfCancelled,
} from "../../utils/polling.js";
import "../../components/install-progress.js";

type InstallStage =
  | "downloading"
  | "extracting"
  | "creating"
  | "starting"
  | "waiting"
  | "ready"
  | "updating"
  | "complete"
  | "error";

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

/** Delay between polls while waiting for the VM and Home Assistant */
const POLL_INTERVAL_MS = 2000;

/** How long to wait for the VM to report an IP address */
const VM_IP_TIMEOUT_MS = 5 * 60 * 1000;

/** How long to wait for the Home Assistant webserver to answer */
const HA_READY_TIMEOUT_MS = 5 * 60 * 1000;

/** How long to wait for Home Assistant to finish updating itself */
const HA_UPDATED_TIMEOUT_MS = 60 * 60 * 1000;

/** VM statuses that mean the VM does not need to be started again */
const RUNNING_VM_STATUSES = ["started", "running", "starting", "resuming"];

@customElement("utm-progress-view")
export class UtmProgressView extends LitElement {
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

  /** Check if a stage uses indeterminate progress */
  private _isIndeterminate(stage: InstallStage): boolean {
    return (
      INDETERMINATE_STAGES.includes(stage) &&
      !this._hasMeasurableProgress(stage)
    );
  }

  /** Check if a stage has measurable progress (0-100%) */
  private _hasMeasurableProgress(stage: InstallStage): boolean {
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
    const vmName = selections.vmName || DEFAULT_UTM_VM_NAME;
    const cpuCores = selections.cpuCores ?? DEFAULT_CPU_CORES;
    const memoryMb = selections.memoryMb ?? DEFAULT_MEMORY_MB;
    const diskSizeGb = selections.diskSizeGb ?? DEFAULT_DISK_SIZE_GB;
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
        this._startStage("creating");

        const config: UtmVmConfig = {
          name: vmName,
          image_path: pending?.config.image_path ?? imagePath!,
          cpu_cores: cpuCores,
          memory_mb: memoryMb,
          disk_size_gb: diskSizeGb,
          auto_start: false,
        };

        vmId = await this._createVm(config, flowGeneration);
        throwIfCancelled(signal);
      }

      // Tracked separately from `vmId`: if the resize fails after the VM was
      // created, a retry must resize it rather than start an undersized VM.
      if (!selections.utmDiskResized) {
        this._startStage("creating");
        await resizeUtmVmDisk(vmId, diskSizeGb);
        throwIfCancelled(signal);
        wizardState.setSelection("utmDiskResized", true);
      }

      this._startStage("starting");
      await this._ensureVmStarted(vmId, signal);
      throwIfCancelled(signal);

      // Wait for the VM to get an IP address. Asked again on a retry rather
      // than reusing the last one: a restarted VM can get a new DHCP lease.
      this._startStage("waiting");
      wizardState.setSelection("ipAddress", undefined);
      const ipAddress = await this._waitForVmIp(vmId, signal);
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
      this._error = installerError(
        error instanceof PollTimeoutError
          ? {
              code: "timeout",
              message: error.message,
              retryable: true,
              details: {},
            }
          : error,
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
    } finally {
      // A newer attempt may own the component by now (cancel, then retry)
      if (this._abortController === controller) {
        this._isInstalling = false;
        this._abortController = undefined;
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

    // Persist the result once, before any awaiting view can resize/start it.
    const result = createUtmVm(config)
      .then((vmId) => {
        const current = wizardState.getState().selections;
        if (wizardState.flowGeneration !== generation || current.vmId) {
          throw changed();
        }
        if (
          (current.vmName || DEFAULT_UTM_VM_NAME) !== config.name ||
          (current.cpuCores ?? DEFAULT_CPU_CORES) !== config.cpu_cores ||
          (current.memoryMb ?? DEFAULT_MEMORY_MB) !== config.memory_mb ||
          (current.diskSizeGb ?? DEFAULT_DISK_SIZE_GB) !== config.disk_size_gb
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
  }

  /** Download the HAOS qcow2 image, reporting download and extract progress */
  private async _downloadImage(signal: AbortSignal): Promise<string> {
    this._diagnostics?.advance("downloading");
    this._stage = "downloading";
    this._progress = 0;
    this._stageStartTime = Date.now();
    this._stageStartBytes = 0;

    return downloadUtmImage((progress: FlashProgress) => {
      // The download itself cannot be cancelled, but a detached view must
      // stop reporting on it
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
    });
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
        .stageTitle=${this._getStageTitle(stage)}
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

  /**
   * Wait for the VM to get an IP address, polling every 2 seconds for up to
   * 5 minutes.
   */
  private async _waitForVmIp(
    vmId: string,
    signal: AbortSignal
  ): Promise<string> {
    return pollUntil(async () => (await getUtmVmStatus(vmId)).ip_address, {
      interval: POLL_INTERVAL_MS,
      timeout: VM_IP_TIMEOUT_MS,
      signal,
      timeoutMessage: localize(
        "views.utm.utm_progress_view.the_virtual_machine_did_not_report_an_ip_address"
      ),
    });
  }

  /**
   * Wait for the Home Assistant webserver to be ready on port 80, polling
   * every 2 seconds for up to 5 minutes.
   *
   * A timeout throws: reporting "Installation complete!" for a VM where Home
   * Assistant never came up leaves the user with no idea what went wrong.
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
        "views.utm.utm_progress_view.home_assistant_did_not_respond_at_value_within_5_minutes",
        { value0: ipAddress }
      ),
    });
  }

  /**
   * Wait for Home Assistant to finish updating to the latest version.
   * This checks for the manifest.json endpoint which becomes available
   * after the initial setup and updates are complete.
   * Polls every 2 seconds for up to 1 hour.
   *
   * As with the readiness check, a timeout throws instead of quietly
   * reporting success.
   */
  private async _waitForHaUpdated(
    ipAddress: string,
    signal: AbortSignal
  ): Promise<void> {
    await pollUntil(async () => (await checkHaUpdated(ipAddress)) || null, {
      interval: POLL_INTERVAL_MS,
      timeout: HA_UPDATED_TIMEOUT_MS,
      signal,
      timeoutMessage: localize("utm.update_timeout", {
        address: `http://${ipAddress}`,
      }),
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "utm-progress-view": UtmProgressView;
  }
}
