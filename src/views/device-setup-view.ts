import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { localize, localizeContent } from "../localization/localize.js";
import { WizardStateController } from "../state/wizard-state-controller.js";
import { wizardState } from "../state/wizard-state.js";
import { goToNextStep } from "../components/wizard-steps.js";
import {
  renderAnnouncedName,
  renderIpUrlPlaceholder,
} from "../utils/device-access.js";
import {
  DEVICE_ADDRESS_TIMEOUT_MS,
  flowDeviceFinder,
} from "../utils/device-discovery.js";
import { homeAssistantUrl } from "../utils/external-url.js";
import {
  haSetupProblemMessage,
  type HaSetupProgress,
} from "../utils/ha-setup.js";
import {
  installerError,
  type InstallerError,
} from "../utils/installer-error.js";
import { linkStyles } from "../utils/link-styles.js";
import { renderRetryButton } from "../utils/load-state.js";
import { isCancelled } from "../utils/polling.js";
import {
  checkedAddress,
  waitError,
  waitForHomeAssistant,
  type WaitStage,
} from "../utils/vm-wait.js";
import "../components/install-progress.js";

/**
 * The waits it shows. Home Assistant answering where the device turned up
 * is part of finding it, as the device is found by its landing page.
 */
const DEVICE_STAGES = ["waiting", "updating"] as const satisfies WaitStage[];

type DeviceStage = (typeof DEVICE_STAGES)[number];

/**
 * Waiting for Home Assistant on the device the drive was written for, the
 * way the VM installs wait for theirs: it looks for the device on the
 * network, waits for Home Assistant to answer there, and shows what its
 * landing page reports while it installs the latest Home Assistant. Then it
 * moves on to the last step, which links to it.
 *
 * Next skips the wait, so nothing here holds anyone up: while it looks, it
 * also says how to find the device without it.
 */
@customElement("device-setup-view")
export class DeviceSetupView extends LitElement {
  static styles = [
    linkStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 100%;
      }

      install-progress {
        width: 100%;
        flex: 1;
      }

      .help {
        max-width: 400px;
        margin: 0 0 1rem;
        font-size: 0.875rem;
        color: var(--ha-secondary-text-color);
        overflow-wrap: anywhere;
      }

      wa-button {
        margin-bottom: 1rem;
      }
    `,
  ];

  private readonly _wizard = new WizardStateController(this);

  @state()
  private _stage: WaitStage | "complete" = "waiting";

  /** What Supervisor reports while it installs Home Assistant */
  @state()
  private _setup: HaSetupProgress = { progress: null, problem: null };

  /** Why the wait at `_stage` ended, until it is tried again */
  @state()
  private _error: InstallerError | null = null;

  private _controller?: AbortController;

  connectedCallback() {
    super.connectedCallback();
    void this._wait();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._controller?.abort();
    this._controller = undefined;
  }

  private async _wait() {
    this._controller?.abort();
    const controller = new AbortController();
    this._controller = controller;
    this._error = null;
    wizardState.setSelection("homeAssistantReady", undefined);
    // Made when the drive was done, so it knows what was there before
    const finder = flowDeviceFinder();
    try {
      await waitForHomeAssistant({
        address: (signal) => finder.find(signal),
        addressTimeout: DEVICE_ADDRESS_TIMEOUT_MS,
        // The device may still start; looking again can always find it
        stopOn: () => false,
        onStage: (stage) => {
          this._stage = stage;
          this._setup = { progress: null, problem: null };
        },
        onSetup: (setup) => (this._setup = setup),
        messages: {
          noAddress: localize("views.device_setup_view.not_found"),
          notResponding: (ipAddress) =>
            localize("views.device_setup_view.not_responding", {
              address: homeAssistantUrl(ipAddress),
            }),
          notUpdated: (address) =>
            localize("views.device_setup_view.not_updated", { address }),
        },
        host: "device",
        signal: controller.signal,
      });
      this._stage = "complete";
      wizardState.setSelection("homeAssistantReady", true);
      goToNextStep(this);
    } catch (error) {
      // Gone from the page, or tried again
      if (isCancelled(error) || controller.signal.aborted) return;
      this._error = installerError(waitError(error));
    }
  }

  render() {
    const stage = this._stage;
    const shown = this._shownStage();
    const { progress, problem } = this._setup;
    const measurable = stage === "updating" && progress !== null;

    return html`
      <install-progress
        .stages=${DEVICE_STAGES.map((id) => ({
          id,
          label: this._stageLabel(id),
        }))}
        .stage=${shown}
        .stageTitle=${this._stageTitle()}
        .description=${this._description()}
        .progress=${measurable ? Math.round(progress) : 0}
        .indeterminate=${stage !== "complete" && !measurable}
        .measurable=${measurable}
        .hideEmptyDetails=${true}
        .error=${this._error?.message ?? null}
        .errorHeading=${this._stage === "waiting"
          ? localize("views.device_setup_view.not_found_title")
          : localize("views.device_setup_view.not_ready_title")}
        .warning=${stage === "updating" && problem
          ? haSetupProblemMessage(problem, "device")
          : null}
        .address=${checkedAddress(
          shown,
          this._wizard.state.selections.ipAddress
        )}
        .leavable=${true}
      >
        ${this._error?.retryable
          ? html`<div slot="help">
              ${renderRetryButton(false, () => this._wait())}
            </div>`
          : nothing}
        ${stage === "waiting"
          ? html`<p class="help" slot="help">
              ${localizeContent("views.device_setup_view.find_it_yourself", {
                url: renderAnnouncedName(),
                ip_url: renderIpUrlPlaceholder(),
              })}
            </p>`
          : nothing}
      </install-progress>
    `;
  }

  /** The stage it shows for the wait at `_stage` */
  private _shownStage(): DeviceStage | "complete" {
    return this._stage === "ready" ? "waiting" : this._stage;
  }

  private _stageLabel(stage: DeviceStage): string {
    switch (stage) {
      case "waiting":
        return localize("views.device_setup_view.looking_for_device");
      case "updating":
        return localize("views.device_setup_view.installing_latest");
    }
  }

  /** The stage in the thinking cloud, which the live region reads out */
  private _stageTitle(): string {
    switch (this._shownStage()) {
      case "waiting":
        return localize("views.device_setup_view.looking");
      case "updating":
        return localize("views.device_setup_view.installing");
      case "complete":
        return localize("common.install.complete");
    }
  }

  private _description(): string {
    const stage = this._shownStage();
    switch (stage) {
      case "updating":
        return localize("views.device_setup_view.installing_description");
      case "complete":
        return localize("common.install.installation_complete");
      default:
        return this._stageLabel(stage);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "device-setup-view": DeviceSetupView;
  }
}
