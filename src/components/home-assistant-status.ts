import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import {
  formatNumber,
  localize,
  localizeContent,
} from "../localization/localize.js";
import { WizardStateController } from "../state/wizard-state-controller.js";
import {
  DEVICE_ADDRESS_TIMEOUT_MS,
  newLandingPageFinder,
} from "../utils/device-discovery.js";
import { renderExternalLink } from "../utils/external-link.js";
import {
  EXTERNAL_LINK_HINT_STYLE,
  EXTERNAL_LINK_REL,
  EXTERNAL_LINK_TARGET,
  homeAssistantUrl,
  openExternalLink,
} from "../utils/external-url.js";
import {
  haSetupProblemMessage,
  type HaSetupProgress,
} from "../utils/ha-setup.js";
import {
  installerError,
  type InstallerError,
} from "../utils/installer-error.js";
import { linkStyles } from "../utils/link-styles.js";
import {
  renderRetryButton,
  renderStatusRow,
  statusRowStyles,
} from "../utils/load-state.js";
import { panelStyles } from "../utils/panel-styles.js";
import { isCancelled } from "../utils/polling.js";
import { statusDotStyles } from "../utils/status-dot-styles.js";
import {
  activeElement,
  focusHeading,
  reducedMotionStyles,
  srOnlyStyles,
} from "../utils/view-accessibility.js";
import {
  WAIT_STAGES,
  waitError,
  waitForHomeAssistant,
  type WaitStage,
} from "../utils/vm-wait.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "./inline-notice.js";
import "./progress-bar.js";

/**
 * Follows the device that starts from the written drive through the waits
 * the VM installs have: it looks for the device on the network, waits for
 * Home Assistant to answer there, shows what its landing page reports while
 * it installs the latest Home Assistant, and then links to it.
 *
 * Getting there doesn't depend on it: while it looks, it says how to find
 * the device without it. It keeps to itself, so changes are read out,
 * never focused.
 */
@customElement("home-assistant-status")
export class HomeAssistantStatus extends LitElement {
  static styles = [
    linkStyles,
    statusRowStyles,
    statusDotStyles,
    srOnlyStyles,
    reducedMotionStyles,
    css`
      :host {
        display: block;
        width: 100%;
        max-width: 500px;
        margin-bottom: 2rem;
        text-align: start;
      }

      .panel {
        ${panelStyles}
        gap: 1rem;
      }

      .stages {
        display: grid;
        gap: 0.75rem;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      /* The install's own stage list, with what the current stage reports
         under its name */
      .stage {
        display: grid;
        grid-template-columns: 8px minmax(0, 1fr);
        align-items: baseline;
        gap: 0.75rem;
        font-size: 0.875rem;
        line-height: 1.4;
        color: var(--ha-secondary-text-color, #727272);
        overflow-wrap: anywhere;
      }

      .stage[aria-current="step"] .stage-label {
        color: var(--ha-text-color, #212121);
        font-weight: 600;
      }

      .status-dot {
        width: 8px;
        height: 8px;
      }

      .status-dot.active {
        animation: pulse-dot 1s ease-in-out infinite;
      }

      @keyframes pulse-dot {
        50% {
          background-color: transparent;
        }
      }

      /* A wait that ended holds still on the stage it ended at */
      .status-dot.active.stopped {
        animation: none;
      }

      @media (forced-colors: active) {
        .status-dot.active {
          animation: none;
        }
      }

      .stage-details {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        margin-top: 0.5rem;
      }

      .stage-details p {
        margin: 0;
      }

      .progress {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }

      .progress progress-bar {
        flex: 1;
        min-width: 0;
      }

      .percentage {
        font-weight: 500;
        color: var(--ha-text-color, #212121);
        white-space: nowrap;
      }

      inline-notice {
        max-width: none;
      }

      wa-button {
        align-self: flex-start;
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

  /** Kept across tries, so it still knows what was there before the device */
  private readonly _find = newLandingPageFinder();

  private _controller?: AbortController;

  /** The name of the stage it waits at, or finished at */
  @query('[aria-current="step"] .stage-label')
  private _currentStage?: HTMLElement | null;

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
    try {
      await waitForHomeAssistant({
        address: this._find,
        addressTimeout: DEVICE_ADDRESS_TIMEOUT_MS,
        // The device may still start; looking again can always find it
        stopOn: () => false,
        onStage: (stage) => {
          this._stage = stage;
          this._setup = { progress: null, problem: null };
        },
        onSetup: (setup) => (this._setup = setup),
        messages: {
          noAddress: localize("components.home_assistant_status.not_found"),
          notResponding: (ipAddress) =>
            localize("components.home_assistant_status.not_responding", {
              address: homeAssistantUrl(ipAddress),
            }),
          notUpdated: (address) =>
            localize("components.home_assistant_status.not_updated", {
              address,
            }),
        },
        host: "device",
        signal: controller.signal,
      });
      this._stage = "complete";
    } catch (error) {
      // Gone from the page, or tried again
      if (isCancelled(error) || controller.signal.aborted) return;
      this._error = installerError(waitError(error));
    }
  }

  /**
   * Wait again. Try again gives way to the stage it waits at, which can take
   * many minutes, so whoever pressed it continues from that stage rather
   * than from the top of the page.
   */
  private async _retry() {
    void this._wait();
    await this.updateComplete;
    const active = activeElement();
    if (active && active !== document.body) return;
    if (this._currentStage) focusHeading(this._currentStage);
  }

  render() {
    const address = this._wizard.state.selections.ipAddress;
    const url = address ? homeAssistantUrl(address) : "";
    const complete = this._stage === "complete";
    const current = complete
      ? WAIT_STAGES.length
      : WAIT_STAGES.indexOf(this._stage as WaitStage);

    return html`
      <div class="panel">
        <!-- WebKit drops list semantics with list-style: none -->
        <ol
          class="stages"
          role="list"
          aria-label=${localize("components.home_assistant_status.stages")}
        >
          ${WAIT_STAGES.map(
            (stage, index) => html`
              <li
                class="stage"
                aria-current=${index === current ? "step" : nothing}
              >
                <span
                  class="status-dot ${index < current
                    ? "completed"
                    : index === current
                      ? `active ${this._error ? "stopped" : ""}`
                      : ""}"
                  aria-hidden="true"
                ></span>
                <div>
                  <span class="stage-label"
                    >${this._stageLabel(stage)}${index < current
                      ? html`<span class="sr-only"
                          >${` ${localize("components.home_assistant_status.completed")}`}</span
                        >`
                      : nothing}</span
                  >
                  ${index === current && !this._error
                    ? this._renderDetails(stage, url)
                    : nothing}
                </div>
              </li>
            `
          )}
        </ol>
        ${this._error
          ? renderStatusRow(
              "error",
              this._stage === "waiting"
                ? localize("components.home_assistant_status.not_found_title")
                : localize("components.home_assistant_status.not_ready_title"),
              this._error.message
            )
          : nothing}
        ${this._error?.retryable
          ? renderRetryButton(false, () => this._retry())
          : nothing}
        ${this._stage === "waiting" ? this._renderFindItYourself() : nothing}
        ${complete ? this._renderComplete(url) : nothing}
        <div class="sr-only" role="status">${this._announcement()}</div>
      </div>
    `;
  }

  private _stageLabel(stage: WaitStage): string {
    switch (stage) {
      case "waiting":
        return localize("components.home_assistant_status.stage_looking");
      case "ready":
        return localize("components.home_assistant_status.stage_waiting");
      case "updating":
        return localize("components.home_assistant_status.stage_updating");
    }
  }

  /** What the current stage reports, under its name */
  private _renderDetails(stage: WaitStage, url: string) {
    let details: TemplateResult;
    switch (stage) {
      case "waiting":
        details = html`<p>
          ${localize("components.home_assistant_status.looking_description")}
        </p>`;
        break;
      case "ready":
        details = html`<p>
          ${localizeContent(
            "components.home_assistant_status.found_description",
            { address: renderExternalLink(url, url) }
          )}
        </p>`;
        break;
      case "updating": {
        const { progress, problem } = this._setup;
        details = html`
          <div class="progress">
            <progress-bar
              .progress=${progress ?? 0}
              .indeterminate=${progress === null}
              .label=${this._stageLabel(stage)}
            ></progress-bar>
            ${progress !== null
              ? html`<span class="percentage"
                  >${formatNumber(Math.round(progress) / 100, {
                    style: "percent",
                  })}</span
                >`
              : nothing}
          </div>
          ${problem
            ? html`<inline-notice
                ><p>
                  ${haSetupProblemMessage(problem, "device")}
                </p></inline-notice
              >`
            : nothing}
          <p>
            ${localizeContent(
              "components.home_assistant_status.updating_description",
              { address: renderExternalLink(url, url) }
            )}
          </p>
        `;
        break;
      }
    }
    return html`<div class="stage-details">${details}</div>`;
  }

  /** How to find the device while this hasn't, or couldn't */
  private _renderFindItYourself() {
    return html`<p class="status-description">
      ${localizeContent("components.home_assistant_status.find_it_yourself", {
        // The sentence already says it opens in the browser
        url: renderExternalLink(homeAssistantUrl(), homeAssistantUrl(), {
          hint: false,
        }),
        ip_url: html`<code dir="ltr"
          >http://&lt;<bdi>${localize(
            "components.home_assistant_status.ip_address"
          )}</bdi>&gt;</code
        >`,
      })}
    </p>`;
  }

  private _renderComplete(url: string) {
    return html`
      ${renderStatusRow(
        "success",
        localize("components.home_assistant_status.ready"),
        localize("components.home_assistant_status.ready_description")
      )}
      <wa-button
        variant="brand"
        href=${url}
        target=${EXTERNAL_LINK_TARGET}
        rel=${EXTERNAL_LINK_REL}
        @click=${openExternalLink}
        >${localize("components.home_assistant_status.open")}<span
          style=${EXTERNAL_LINK_HINT_STYLE}
          >${` ${localize("common.opens_in_browser")}`}</span
        ></wa-button
      >
    `;
  }

  /**
   * What the live region reads out: the stage, once it moves on, a problem
   * that holds it up, and how the wait ended. Not the progress, which would
   * be read out at every percent.
   */
  private _announcement(): string {
    if (this._error) {
      return this._stage === "waiting"
        ? localize("components.home_assistant_status.not_found_title")
        : localize("components.home_assistant_status.not_ready_title");
    }
    switch (this._stage) {
      // Shown from the start, so there is nothing new to read out
      case "waiting":
        return "";
      case "complete":
        return localize("components.home_assistant_status.ready");
      case "updating": {
        const { problem } = this._setup;
        const stage = this._stageLabel(this._stage);
        return problem
          ? `${stage}. ${haSetupProblemMessage(problem, "device")}`
          : stage;
      }
      default:
        return this._stageLabel(this._stage);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "home-assistant-status": HomeAssistantStatus;
  }
}
