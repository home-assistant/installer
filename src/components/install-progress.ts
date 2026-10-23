import { LitElement, html, css, nothing } from "lit";
import {
  formatNumber,
  getLanguage,
  localize,
  localizeContent,
} from "../localization/localize.js";
import { customElement, property } from "lit/decorators.js";
import { formatBytes } from "../utils/format.js";
import {
  renderCasitaThinking,
  renderCasitaHappy,
  renderCasitaSad,
  thinkingCloudStyles,
} from "./install-mascot.js";
import "./progress-bar.js";
import "./inline-notice.js";
import { renderErrorHelp } from "../utils/installer-error.js";
import { openExternalLink } from "../utils/external-url.js";
import { linkStyles } from "../utils/link-styles.js";
import { statusDotStyles } from "../utils/status-dot-styles.js";
import {
  LiveStatus,
  ViewAccessibility,
  reducedMotionStyles,
  srOnlyStyles,
} from "../utils/view-accessibility.js";

export interface InstallStage {
  id: string;
  label: string;
}

@customElement("install-progress")
export class InstallProgress extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  private readonly _status = new LiveStatus(this);

  static styles = [
    srOnlyStyles,
    reducedMotionStyles,
    linkStyles,
    statusDotStyles,
    thinkingCloudStyles,
    css`
      /* Its own width, not the window's, decides between the layouts */
      :host {
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-height: 100%;
        container-type: inline-size;
      }

      /* Narrow, Casita stands above the details, with room for the cloud and
         the 5px its top bump rises above it */
      .layout {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding-top: 115px;
      }

      .details {
        display: flex;
        flex-direction: column;
        align-items: center;
        width: 100%;
      }

      .mascot-container {
        width: 120px;
        height: 120px;
        margin-bottom: 2rem;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        overflow: visible;
      }

      .mascot-container.with-bubble {
        margin-left: 40px;
      }

      .casita-mascot {
        width: 100%;
        height: 100%;
      }

      h2 {
        font-size: 1.25rem;
        font-weight: 500;
        color: var(--ha-text-color, #212121);
        margin: 0 0 0.25rem 0;
        text-align: center;
      }

      .progress-section {
        width: 100%;
        max-width: 400px;
        margin-bottom: 1rem;
      }

      .progress-details {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-top: 0.75rem;
        font-size: 0.875rem;
        color: var(--ha-secondary-text-color, #727272);
      }

      .percentage {
        font-weight: 500;
        color: var(--ha-text-color, #212121);
      }

      .progress-right {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.125rem;
      }

      .eta {
        font-size: 0.75rem;
        color: var(--ha-secondary-text-color, #727272);
        min-height: 1.125rem;
      }

      .bytes-info {
        min-height: 1.25rem;
      }

      .progress-left {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.125rem;
      }

      .speed {
        font-size: 0.75rem;
        color: var(--ha-secondary-text-color, #727272);
        min-height: 1.125rem;
      }

      .error-message {
        color: var(--ha-error-color, #db4437);
        font-size: 0.9375rem;
        margin: 0.5rem 0 1.5rem 0;
        max-width: 400px;
        overflow-wrap: anywhere;
      }

      .stages-indicator {
        display: grid;
        gap: 0.5rem;
        width: 100%;
        max-width: 400px;
        margin: 1rem 0 1.5rem;
        padding: 0;
        list-style: none;
      }

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

      .stage[aria-current="step"] {
        color: var(--ha-text-color, #212121);
        font-weight: 600;
      }

      /* Smaller than the step indicator's, and as wide as their column */
      .status-dot {
        width: 8px;
        height: 8px;
        transition: background-color 0.3s ease;
      }

      /* The ring stays while the dot pulses empty and back */
      .status-dot.active {
        animation: pulse-dot 1s ease-in-out infinite;
      }

      @keyframes pulse-dot {
        50% {
          background-color: transparent;
        }
      }

      /* Forced colors would paint the pulse like the page, so the dot holds
         still */
      @media (forced-colors: active) {
        .status-dot.active {
          animation: none;
        }
      }

      /* Too narrow for the cloud beside Casita, which takes 510px: stack it
         above instead, clear of the roof */
      @container (max-width: 520px) {
        .layout {
          padding-top: 5px;
        }

        .mascot-container.with-bubble {
          margin-left: 0;
          margin-top: 130px;
        }

        .thinking-cloud {
          top: -130px;
          right: -40px;
        }
      }

      /* Always there, as a live region, but takes no room while empty */
      .warning {
        width: 100%;
        max-width: 400px;
      }

      .warning inline-notice {
        margin-bottom: 1rem;
      }

      .address {
        font-size: 0.9375rem;
        color: var(--ha-secondary-text-color, #727272);
        margin: 0 0 1rem 0;
        text-align: center;
        overflow-wrap: anywhere;
      }

      .stage-description {
        font-size: 0.9375rem;
        font-weight: 400;
        color: var(--ha-secondary-text-color, #727272);
        margin: 0 0 1.5rem 0;
        text-align: center;
      }

      /* Wide enough, Casita and the cloud stand beside the details, under the
         heading, so the artwork doesn't push the progress down and out of
         view */
      @container (min-width: 640px) {
        .layout {
          flex-flow: row wrap;
          justify-content: center;
          gap: 1rem 3rem;
          padding-top: 0;
        }

        /* Casita is hidden from assistive technology, so moving the heading
           above it leaves the reading order as it was */
        h2 {
          order: -1;
          flex-basis: 100%;
        }

        /* No basis, so the details share Casita's line even where they have
           to narrow to fit */
        .details {
          align-items: stretch;
          flex: 1 1 0;
          max-width: 400px;
          min-width: 0;
        }

        .mascot-container {
          flex-shrink: 0;
          margin-bottom: 0;
        }

        /* The margins make the room the cloud takes above and beside Casita */
        .mascot-container.with-bubble {
          margin: 110px 175px 0 0;
        }

        .address,
        .stage-description {
          text-align: start;
        }
      }
    `,
  ];

  @property({ attribute: false }) stages: InstallStage[] = [];
  @property() stage = "downloading";
  /** A bare stage name, as the thinking cloud adds its own ellipsis */
  @property({ attribute: "stage-title" }) stageTitle = localize(
    "common.install.downloading"
  );
  @property() description = localize(
    "common.install.installing_home_assistant"
  );
  @property({ type: Number }) progress = 0;
  @property({ type: Number, attribute: "bytes-processed" }) bytesProcessed = 0;
  @property({ type: Number, attribute: "total-bytes" }) totalBytes = 0;
  @property({ type: Number, attribute: "stage-start-time" })
  stageStartTime: number | null = null;
  @property({ type: Number, attribute: "stage-start-bytes" })
  stageStartBytes = 0;
  @property({ type: Boolean }) indeterminate = false;
  @property({ type: Boolean }) measurable = true;
  @property({ type: Boolean, attribute: "show-unknown-bytes" })
  showUnknownBytes = false;
  @property({ type: Boolean, attribute: "hide-empty-details" })
  hideEmptyDetails = false;
  @property({ attribute: false }) error: string | null = null;
  /** A problem holding up the stage, while the install goes on */
  @property({ attribute: false }) warning: string | null = null;
  /** Where Home Assistant is being checked, once the VM has an address */
  @property({ attribute: false }) address: string | null = null;
  /** Leaving no longer stops anything, so the window may close */
  @property({ type: Boolean }) leavable = false;

  render() {
    // The live region stays mounted through errors so a retry is announced
    return html`
      <p class="sr-only" role="status" aria-atomic="true">
        ${this._status.ready && !this.error ? this.stageTitle : ""}
      </p>
      ${this._renderContent()}
    `;
  }

  private _renderContent() {
    if (this.error) {
      return html`
        <div class="layout">
          <div class="mascot-container" aria-hidden="true">
            ${renderCasitaSad()}
          </div>
          <h2>
            ${localize("components.install_progress.installation_failed")}
          </h2>
          <div class="details">
            <p class="error-message" data-focus-alert>${this.error}</p>
            ${renderErrorHelp()}
          </div>
        </div>
      `;
    }
    const hasBubble = this.stage !== "complete" && this.stage !== "error";
    // Its live region is mounted empty first, so the first warning is announced
    const warning = this._status.ready ? this.warning : null;
    const currentIndex = this.stages.findIndex(
      (stage) => stage.id === this.stage
    );
    return html`
      <div class="layout">
        <div
          class="mascot-container ${hasBubble ? "with-bubble" : ""}"
          aria-hidden="true"
        >
          ${this.stage === "complete"
            ? renderCasitaHappy()
            : this.stage === "error"
              ? renderCasitaSad()
              : renderCasitaThinking(this.stageTitle)}
        </div>
        <h2>${this.description}</h2>
        <div class="details">
          <slot></slot>
          <ol
            class="stages-indicator"
            aria-label=${localize(
              "components.install_progress.installation_stages"
            )}
          >
            ${this.stages.map(
              (stage, index) => html`
                <li
                  class="stage"
                  aria-current=${index === currentIndex ? "step" : nothing}
                >
                  <span
                    class="status-dot ${this.stage === "complete" ||
                    index < currentIndex
                      ? "completed"
                      : index === currentIndex
                        ? "active"
                        : ""}"
                    aria-hidden="true"
                  ></span>
                  <span class="stage-label"
                    >${stage.label}${this.stage === "complete" ||
                    index < currentIndex
                      ? html`<span class="sr-only"
                          >${` ${localize("components.install_progress.completed")}`}</span
                        >`
                      : nothing}</span
                  >
                </li>
              `
            )}
          </ol>
          <div class="progress-section">
            <progress-bar
              .progress=${this.progress}
              ?indeterminate=${this.indeterminate}
              .label=${this.stageTitle}
            ></progress-bar>
            ${this.measurable || !this.hideEmptyDetails
              ? html`
                  <div class="progress-details">
                    <div class="progress-left">
                      <span class="bytes-info"
                        >${this.showUnknownBytes && this.indeterminate
                          ? formatBytes(this.bytesProcessed)
                          : this.measurable && this.totalBytes > 0
                            ? this.stage === "extracting"
                              ? localize(
                                  "components.install_progress.byte_progress_compressed",
                                  {
                                    completed: formatBytes(this.bytesProcessed),
                                    total: formatBytes(this.totalBytes),
                                  }
                                )
                              : localize(
                                  "components.install_progress.byte_progress",
                                  {
                                    completed: formatBytes(this.bytesProcessed),
                                    total: formatBytes(this.totalBytes),
                                  }
                                )
                            : ""}</span
                      >
                      <span class="speed"
                        >${this.measurable && this.totalBytes > 0
                          ? this._calculateSpeed()
                          : ""}</span
                      >
                    </div>
                    <div class="progress-right">
                      <span class="percentage"
                        >${this.measurable
                          ? formatNumber(this._percentage() / 100, {
                              style: "percent",
                            })
                          : ""}</span
                      >
                      <span class="eta"
                        >${this.measurable && this.totalBytes > 0
                          ? this._calculateEta() ||
                            localize("components.install_progress.calculating")
                          : ""}</span
                      >
                    </div>
                  </div>
                `
              : ""}
          </div>
          <div class="warning" role="status">
            ${warning
              ? html`<inline-notice><p>${warning}</p></inline-notice>`
              : nothing}
          </div>
          ${this.address
            ? html`<p class="address">
                ${localizeContent(
                  "components.install_progress.checking_address",
                  {
                    address: html`<a
                      href=${this.address}
                      @click=${openExternalLink}
                      >${this.address}</a
                    >`,
                  }
                )}
              </p>`
            : nothing}
          ${this.leavable
            ? nothing
            : html`<p class="stage-description">
                ${localize("components.install_progress.keep_window_open")}
              </p>`}
        </div>
      </div>
    `;
  }

  /** A whole percent on the bar's track, whatever a view passes */
  private _percentage(): number {
    return Math.min(100, Math.max(0, Math.round(this.progress)));
  }

  private _calculateEta(): string | null {
    if (!this.stageStartTime) return null;

    // No ETA for stages without byte tracking
    if (this.totalBytes === 0) return null;

    const elapsed = (Date.now() - this.stageStartTime) / 1000;
    const bytesInStage = this.bytesProcessed - this.stageStartBytes;

    if (elapsed < 1 || bytesInStage <= 0) return null;

    const bytesPerSecond = bytesInStage / elapsed;
    if (bytesPerSecond <= 0) return null;

    const remainingBytes = this.totalBytes - this.bytesProcessed;
    const remainingSeconds = remainingBytes / bytesPerSecond;

    if (remainingSeconds < 0 || !isFinite(remainingSeconds)) return null;

    if (remainingSeconds < 60) {
      return localize(
        "components.install_progress.less_than_a_minute_remaining"
      );
    }
    // Rounded up once, before splitting: 59m 50s left is "1h 0m", never
    // "60 minutes", and 1h 59m 50s is "2h 0m", never "1h 60m"
    const totalMinutes = Math.ceil(remainingSeconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    return localize("components.install_progress.time_remaining", {
      duration: new Intl.DurationFormat(getLanguage(), {
        // "30 minutes" on its own, but "1h 30m" next to hours
        style: hours ? "narrow" : "long",
        minutesDisplay: "always",
      }).format({ hours, minutes: totalMinutes % 60 }),
    });
  }

  private _calculateSpeed(): string {
    if (!this.stageStartTime) return "";

    // No speed for stages without byte tracking
    if (this.totalBytes === 0) return "";

    const elapsed = (Date.now() - this.stageStartTime) / 1000;
    const bytesInStage = this.bytesProcessed - this.stageStartBytes;

    if (elapsed < 0.5 || bytesInStage <= 0) return "";

    const bytesPerSecond = bytesInStage / elapsed;
    if (bytesPerSecond <= 0 || !isFinite(bytesPerSecond)) return "";

    return formatBytes(bytesPerSecond, true);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "install-progress": InstallProgress;
  }
}
