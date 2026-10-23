import { installerError } from "../../utils/installer-error.js";
import { localize } from "../../localization/localize.js";
import { customElement } from "lit/decorators.js";
import { wizardState } from "../../state/wizard-state.js";
import { proxmoxCreateVm, proxmoxGetVmStatus } from "../../api/commands.js";
import type {
  FlashProgress,
  FlashStage,
  ProxmoxSession,
  ProxmoxVmConfig,
  ProxmoxVmResult,
} from "../../api/types.js";
import { proxmoxVmConfig } from "../../state/vm-defaults.js";
import { throwIfCancelled } from "../../utils/polling.js";
import {
  SESSION_EXPIRED,
  forgetProxmoxSession,
  needsReconnect,
} from "./proxmox-session.js";
import { VmProgressView } from "../vm-progress-view.js";

/** The stages `proxmoxCreateVm` reports, in order */
const BACKEND_STAGES = [
  "downloading",
  "extracting",
  "uploading",
  "creating_vm",
  "starting_vm",
] as const satisfies readonly FlashStage[];

type BackendStage = (typeof BACKEND_STAGES)[number];

function isBackendStage(stage: FlashStage): stage is BackendStage {
  return (BACKEND_STAGES as readonly FlashStage[]).includes(stage);
}

/**
 * Whether a failed VM status request cannot succeed by asking again.
 *
 * An expired session or a missing permission fails every poll the same way,
 * and waiting out the timeout would hide it behind "no IP address". Errors
 * without a structured code are still treated as "not ready yet".
 */
function needsUserAction(error: unknown): boolean {
  const { code, retryable } = installerError(error);
  if (code === "unknown") return false;
  return !retryable || code === "proxmox_action_required";
}

@customElement("proxmox-progress-view")
export class ProxmoxProgressView extends VmProgressView<BackendStage> {
  protected readonly _flow = "proxmox";

  protected readonly _stages = BACKEND_STAGES;

  /** Past these, the VM exists, and the install runs to the end */
  protected readonly _stoppableStages = [
    "downloading",
    "extracting",
    "uploading",
  ];

  protected readonly _measurableStages = [
    "downloading",
    "extracting",
    "uploading",
  ];

  protected _stoppedMessage(): string {
    return localize(
      "views.proxmox.proxmox_progress_view.stopped_nothing_created"
    );
  }

  protected _startFailure() {
    if (this._wizardState.selections.proxmoxSession) return undefined;

    // Answered like an expired one: by logging in again
    return {
      error: {
        code: SESSION_EXPIRED,
        message: "",
        retryable: false,
        details: {},
      },
      message: localize(
        "views.proxmox.proxmox_progress_view.no_proxmox_session_available"
      ),
    };
  }

  protected async _install(signal: AbortSignal) {
    const selections = this._wizardState.selections;
    // `_startFailure` holds back an install without one
    const session = selections.proxmoxSession!;
    const config = proxmoxVmConfig(selections);

    // Skipped when an earlier attempt already created the VM: running it
    // again after a late failure would try to create a second VM with the
    // same id, which Proxmox rejects.
    let result = selections.proxmoxVmResult;
    if (!result) {
      result = await this._createVm(session, config, signal);
      throwIfCancelled(signal);
      wizardState.setSelection("proxmoxVmResult", result);
    }

    const { node, vm_id } = result;
    await this._waitForHomeAssistant(
      {
        vmAddress: async () =>
          (await proxmoxGetVmStatus(session, node, vm_id)).ip_address,
        stopOn: needsUserAction,
        messages: {
          noAddress: localize(
            "views.proxmox.proxmox_progress_view.no_ip_address"
          ),
          notResponding: (ipAddress) =>
            localize("views.proxmox.proxmox_progress_view.not_responding", {
              address: ipAddress,
            }),
          notUpdated: (address) =>
            localize("views.proxmox.proxmox_progress_view.update_timeout", {
              address,
            }),
        },
      },
      signal
    );
    return { result };
  }

  /** Create and start the VM, reporting the backend's progress */
  private async _createVm(
    session: ProxmoxSession,
    config: ProxmoxVmConfig,
    signal: AbortSignal
  ): Promise<ProxmoxVmResult> {
    const result = await this._runBackendStep((attempt) =>
      proxmoxCreateVm(
        session,
        config,
        (progress: FlashProgress) => {
          // Progress keeps arriving from the backend after a cancel; a
          // detached view must stop reporting on it
          if (signal.aborted) return;

          if (!isBackendStage(progress.stage)) {
            // A stage the backend gained without this view learning it
            console.warn(
              `Ignoring unknown Proxmox install stage: ${progress.stage}`
            );
            return;
          }

          this._showProgress(progress.stage, progress);
        },
        attempt
      )
    );
    // A stop that came too late: the VM exists, so the install goes on
    this._stopping = false;
    return result;
  }

  /**
   * Show an error and tell the shell whether a retry is safe, or whether
   * only logging in again can get past it.
   */
  protected _fail(error: unknown, message?: string) {
    // Reconnecting resumes a VM made in full, or starts one not made yet. A
    // VM that failed while being made may exist half way, unknown to the
    // installer: a new install would find its VM ID taken, or leave it
    // behind under another one.
    const halfMade =
      !this._stoppableStages.includes(this._stage) &&
      !wizardState.getState().selections.proxmoxVmResult;
    const reconnect = needsReconnect(error) && !halfMade;
    if (needsReconnect(error) && halfMade) {
      message = localize(
        "views.proxmox.proxmox_progress_view.connection_lost_while_creating"
      );
    }
    if (reconnect) forgetProxmoxSession();
    super._fail(error, message, { reconnect });
  }

  protected _stageTitle(stage: BackendStage): string {
    return stage === "uploading"
      ? localize("views.proxmox.proxmox_progress_view.uploading")
      : super._stageTitle(stage);
  }

  protected _stageDescription(stage: BackendStage): string {
    return stage === "uploading"
      ? localize(
          "views.proxmox.proxmox_progress_view.uploading_image_to_proxmox"
        )
      : super._stageDescription(stage);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "proxmox-progress-view": ProxmoxProgressView;
  }
}
