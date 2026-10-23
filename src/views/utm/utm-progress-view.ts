import { installerError } from "../../utils/installer-error.js";
import { localize } from "../../localization/localize.js";
import { logFrontendError } from "../../utils/diagnostics.js";
import { customElement } from "lit/decorators.js";
import { wizardState } from "../../state/wizard-state.js";
import {
  downloadUtmImage,
  discardUtmImage,
  createUtmVm,
  startUtmVm,
  getUtmVmStatus,
  type VmStatusInfo,
} from "../../api/commands.js";
import type { FlashProgress, UtmVmConfig } from "../../api/types.js";
import { utmVmConfig } from "../../state/vm-defaults.js";
import { throwIfCancelled } from "../../utils/polling.js";
import { VmProgressView } from "../vm-progress-view.js";

/** The image download, then UTM making and starting the VM */
type UtmStage = "downloading" | "extracting" | "creating" | "starting";

/**
 * Whether a failed VM status request cannot succeed by asking again.
 *
 * When UTM answers with an error, like missing Automation access or a VM
 * that was removed, it answers the same way every time, and waiting would
 * only hide the cause behind "no IP address". No answer at all, like a UTM
 * that is busy starting the VM, can pass. Errors without a structured code
 * are still treated as "not ready yet".
 */
function failsEveryTime(error: unknown): boolean {
  const { code } = installerError(error);
  return code === "utm" || code === "unsupported_platform";
}

/** Shaped like the backend's rejection after a stop. */
const STOPPED = {
  code: "cancelled",
  message: "Installation was cancelled.",
  retryable: true,
  details: {},
};

/** VM statuses that mean the VM does not need to be started again */
const RUNNING_VM_STATUSES = ["started", "running", "starting", "resuming"];

@customElement("utm-progress-view")
export class UtmProgressView extends VmProgressView<UtmStage> {
  protected readonly _flow = "utm";

  protected readonly _stages: readonly UtmStage[] = [
    "downloading",
    "extracting",
    "creating",
    "starting",
  ];

  /** Past these, UTM creates the VM, and the install runs to the end */
  protected readonly _stoppableStages: readonly UtmStage[] = [
    "downloading",
    "extracting",
  ];

  protected readonly _measurableStages: readonly UtmStage[] = [
    "downloading",
    "extracting",
  ];

  protected _stoppedMessage(): string {
    return localize("views.utm.utm_progress_view.stopped_nothing_created");
  }

  protected _startFailure() {
    // A VM made with settings changed since is left for the user to check:
    // making another would put two in UTM
    const { vmId, utmSupersededVmId } = this._wizardState.selections;
    if (vmId || !utmSupersededVmId) return undefined;

    return {
      error: new Error(
        localize("views.utm.utm_progress_view.vm_already_created")
      ),
    };
  }

  protected async _install(signal: AbortSignal) {
    const selections = this._wizardState.selections;
    const flowGeneration = wizardState.flowGeneration;
    let imagePath: string | undefined;

    try {
      // Every step below is skipped when an earlier attempt already completed
      // it. Running the whole pipeline again after a late failure would create
      // a second VM with the same name and orphan the first one.
      let vmId = selections.vmId;
      if (!vmId) {
        const pending = selections.utmCreation;
        let image: string;
        if (pending) {
          // A creation an earlier attempt started has its image already
          image = pending.config.image_path;
        } else {
          imagePath = await this._downloadImage(signal);
          image = imagePath;
        }
        throwIfCancelled(signal);
        // A stop that landed as the download finished still holds back the VM
        if (this._stopping) throw STOPPED;
        this._startStage("creating");

        const config: UtmVmConfig = {
          ...utmVmConfig(selections),
          image_path: image,
        };

        vmId = await this._createVm(config, flowGeneration);
        throwIfCancelled(signal);
      }

      this._startStage("starting");
      await this._ensureVmStarted(vmId, signal);
      throwIfCancelled(signal);

      const startedVmId = vmId;
      const app = "UTM";
      await this._waitForHomeAssistant(
        {
          address: async () => (await getUtmVmStatus(startedVmId)).ip_address,
          stopOn: failsEveryTime,
          messages: {
            noAddress: localize("common.vm.no_ip_address", { app }),
            notResponding: (ipAddress) =>
              localize("common.vm.not_responding", {
                address: ipAddress,
                app,
              }),
            notUpdated: (address) =>
              localize("common.vm.update_timeout", { address }),
          },
        },
        signal
      );
    } finally {
      // Not awaited, so it doesn't hold up the result. An image UTM imported
      // is no longer the backend's to delete.
      if (imagePath) discardUtmImage(imagePath).catch(logFrontendError);
    }
  }

  private _createVm(config: UtmVmConfig, generation: number): Promise<string> {
    const changed = () =>
      new Error(localize("views.utm.utm_progress_view.installation_changed"));
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

    // Persist the result once, before any awaiting view can start it.
    const result = createUtmVm(config)
      .then((vmId) => {
        const current = wizardState.getState().selections;
        if (wizardState.flowGeneration !== generation || current.vmId) {
          throw changed();
        }
        const chosen = utmVmConfig(current);
        if (
          chosen.name !== config.name ||
          chosen.cpu_cores !== config.cpu_cores ||
          chosen.memory_mb !== config.memory_mb ||
          chosen.disk_size_gb !== config.disk_size_gb
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

  /** Download the HAOS qcow2 image, reporting download and extract progress */
  private _downloadImage(signal: AbortSignal): Promise<string> {
    return this._runBackendStep((attempt) =>
      downloadUtmImage((progress: FlashProgress) => {
        // Only a stop ends the download early, but a detached view must stop
        // reporting on it
        if (signal.aborted) return;

        // The download goes on to extract the image, then reports it is done
        this._showProgress(
          progress.stage === "extracting" ? "extracting" : this._stage,
          progress
        );
      }, attempt)
    );
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
}

declare global {
  interface HTMLElementTagNameMap {
    "utm-progress-view": UtmProgressView;
  }
}
