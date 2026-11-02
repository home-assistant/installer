import { LitElement, html, css, nothing } from "lit";
import {
  formatNumber,
  getLanguage,
  localize,
  localizeContent,
} from "../localization/localize.js";
import { customElement, property, state } from "lit/decorators.js";
import { formatBytes } from "../utils/format.js";
import { mdiChevronRight } from "../utils/icons.js";
import { renderIcon } from "../utils/render-icon.js";
import {
  renderCasitaFocusing,
  renderCasitaHappy,
  renderCasitaSad,
} from "./install-mascot.js";
import "./progress-bar.js";
import "./inline-notice.js";
import { renderErrorHelp } from "../utils/installer-error.js";
import { renderExternalLink } from "../utils/external-link.js";
import { linkStyles } from "../utils/link-styles.js";
import { statusDotStyles } from "../utils/status-dot-styles.js";
import { roomForMascotBeside } from "../utils/breakpoints.js";
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
    css`
      /* Its own width, not the window's, decides between the layouts */
      :host {
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-height: 100%;
        container-type: inline-size;
      }

      /* Narrow, Casita stands above the details */
      .layout {
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      /* The heading included, so all text starts on one edge */
      .details {
        display: flex;
        flex-direction: column;
        width: 100%;
        max-width: var(--ha-content-narrow-width);
      }

      .mascot-container {
        width: 120px;
        height: 120px;
        margin-bottom: 2rem;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .casita-mascot {
        width: 100%;
        height: 100%;
      }

      h2 {
        font-size: 1.375rem;
        font-weight: 500;
        line-height: 1.3;
        color: var(--ha-text-color);
        margin: 0;
        overflow-wrap: anywhere;
        transition: font-size 0.3s ease;
      }

      /* Quieter than the heading below it, which it opens the stages around */
      .parts {
        display: flex;
        align-items: center;
        align-self: flex-start;
        gap: 0.25rem;
        margin: 0 0 0.375rem;
        padding: 0.125rem 0;
        border: 0;
        background: none;
        font: inherit;
        font-size: 0.8125rem;
        font-weight: 500;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--ha-secondary-text-color);
        cursor: pointer;
      }

      .parts:focus-visible {
        outline: var(--wa-focus-ring);
        outline-offset: var(--wa-focus-ring-offset);
      }

      .chevron {
        width: 14px;
        height: 14px;
        fill: currentColor;
        transition: transform 0.3s ease;
      }

      [aria-expanded="true"] .chevron {
        transform: rotate(90deg);
      }

      .progress-section {
        width: 100%;
        max-width: var(--ha-content-narrow-width);
        margin-bottom: 1rem;
      }

      .progress-details {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-top: 0.75rem;
        font-size: 0.875rem;
        color: var(--ha-secondary-text-color);
      }

      .percentage {
        font-weight: 500;
        color: var(--ha-text-color);
      }

      .progress-right {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.125rem;
      }

      .eta {
        font-size: 0.75rem;
        color: var(--ha-secondary-text-color);
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
        color: var(--ha-secondary-text-color);
        min-height: 1.125rem;
      }

      .error-message {
        color: var(--ha-error-color);
        font-size: 0.9375rem;
        margin: 0.5rem 0 1.5rem 0;
        max-width: var(--ha-content-narrow-width);
        overflow-wrap: anywhere;
      }

      .stages {
        margin: 0 0 1.25rem;
        padding: 0;
        list-style: none;
        transition: margin-bottom 0.3s ease;
      }

      .stages.open {
        margin-bottom: 0.75rem;
      }

      /* Open, the done stages grow in above the heading and the upcoming ones
         below it. Hidden, they are gone for assistive technology too. */
      .stage {
        display: grid;
        grid-template-rows: 0fr;
        opacity: 0;
        visibility: hidden;
        transition:
          grid-template-rows 0.3s ease,
          opacity 0.3s ease,
          visibility 0s 0.3s;
      }

      .open .stage {
        grid-template-rows: 1fr;
        opacity: 1;
        visibility: visible;
        transition-delay: 0s;
      }

      /* Clips what doesn't fit yet while it grows */
      .row {
        display: flex;
        align-items: center;
        overflow: hidden;
        font-size: 0.875rem;
        line-height: 1.4;
        color: var(--ha-secondary-text-color);
        overflow-wrap: anywhere;
      }

      .stage-label {
        min-width: 0;
        padding: 0.25rem 0;
      }

      /* As tall as a stage's row once it shrinks to one */
      .current {
        display: flex;
        align-items: center;
        min-height: 1.75rem;
      }

      .open h2 {
        font-size: 0.9375rem;
      }

      /* The current stage's ring, which the heading takes as a row */
      .marker {
        display: flex;
        flex: none;
        width: 0;
        overflow: hidden;
        opacity: 0;
        transition:
          width 0.3s ease,
          opacity 0.3s ease;
      }

      .open .marker {
        width: 28px;
        opacity: 1;
      }

      /* Smaller than the step indicator's. Each takes the 28px before its
         text, with room for the current one's ring. */
      .status-dot {
        flex: none;
        width: 8px;
        height: 8px;
        margin: 4px 15px 4px 5px;
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

      /* Always there, as a live region, but takes no room while empty */
      .warning {
        width: 100%;
        max-width: var(--ha-content-narrow-width);
      }

      .warning inline-notice {
        margin-bottom: 1rem;
      }

      .address {
        font-size: 0.9375rem;
        color: var(--ha-secondary-text-color);
        margin: 0 0 1rem 0;
        overflow-wrap: anywhere;
      }

      .stage-description {
        font-size: 0.9375rem;
        font-weight: 400;
        color: var(--ha-secondary-text-color);
        margin: 0 0 1.5rem 0;
      }

      /* Wide enough, Casita stands beside the details, so the artwork
         doesn't push the progress down and out of view */
      @container ${roomForMascotBeside} {
        .layout {
          flex-direction: row;
          justify-content: center;
          gap: 3rem;
        }

        /* No basis, so the details share Casita's line even where they have
           to narrow to fit */
        .details {
          flex: 1 1 0;
          min-width: 0;
        }

        .mascot-container {
          flex-shrink: 0;
          margin-bottom: 0;
        }
      }
    `,
  ];

  @property({ attribute: false }) stages: InstallStage[] = [];
  @property() stage = "downloading";
  /** The stage's short name, for the live region and the progress bar */
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
  /** What the error's heading says, if the install did not simply fail */
  @property({ attribute: false }) errorHeading: string | null = null;
  /** A stop was asked for, which the heading says instead of the stage */
  @property({ type: Boolean }) stopping = false;

  /** Whether the stage list is open, which outlasts stage changes */
  @state() private _partsOpen = false;

  render() {
    // The live region stays mounted through errors so a retry is announced
    return html`
      <p class="sr-only" role="status" aria-atomic="true">
        ${this._status.ready && !this.error ? this._title() : ""}
      </p>
      ${this._renderContent()}
    `;
  }

  /** The stage's short name, or that the install stops */
  private _title(): string {
    return this.stopping
      ? localize("components.install_progress.stopping")
      : this.stageTitle;
  }

  private _renderContent() {
    if (this.error) {
      return html`
        <div class="layout">
          <div class="mascot-container" aria-hidden="true">
            ${renderCasitaSad()}
          </div>
          <div class="details">
            <h2>
              ${this.errorHeading ??
              localize("components.install_progress.installation_failed")}
            </h2>
            <p class="error-message" data-focus-alert>${this.error}</p>
            ${renderErrorHelp()}
            <slot name="help"></slot>
          </div>
        </div>
      `;
    }
    // Its live region is mounted empty first, so the first warning is announced
    const warning = this._status.ready ? this.warning : null;
    const current = this.stages.findIndex((stage) => stage.id === this.stage);
    const done = current < 0 ? [] : this.stages.slice(0, current);
    const upcoming = current < 0 ? [] : this.stages.slice(current + 1);
    // Stopping, the heading no longer names a stage to list it with
    const parts = done.length + upcoming.length > 0 && !this.stopping;
    const open = parts && this._partsOpen;
    return html`
      <div class="layout">
        <div class="mascot-container" aria-hidden="true">
          ${this.stage === "complete"
            ? renderCasitaHappy()
            : this.stage === "error"
              ? renderCasitaSad()
              : renderCasitaFocusing()}
        </div>
        <div class="details">
          ${parts
            ? html`<button
                class="parts"
                type="button"
                aria-expanded=${open ? "true" : "false"}
                aria-controls="stages"
                @click=${this._toggleParts}
              >
                ${localize("components.install_progress.part_of", {
                  current: current + 1,
                  total: this.stages.length,
                })}${renderIcon(mdiChevronRight, "chevron")}
              </button>`
            : nothing}
          <!-- WebKit drops list semantics with list-style: none. Closed, it
               is only the heading. -->
          <ol
            id="stages"
            class="stages ${open ? "open" : ""}"
            role=${open ? "list" : "none"}
            aria-label=${open
              ? localize("components.install_progress.installation_stages")
              : nothing}
          >
            ${done.map((stage) => this._renderStage(stage, true))}
            <li class="current" aria-current=${open ? "step" : nothing}>
              <span class="marker" aria-hidden="true">
                <span class="status-dot active"></span>
              </span>
              <h2>${this.stopping ? this._title() : this.description}</h2>
            </li>
            ${upcoming.map((stage) => this._renderStage(stage, false))}
          </ol>
          <slot></slot>
          <div class="progress-section">
            <progress-bar
              .progress=${this.progress}
              ?indeterminate=${this.indeterminate}
              .label=${this._title()}
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
                    address: renderExternalLink(this.address, this.address),
                  }
                )}
              </p>`
            : nothing}
          ${this.leavable
            ? nothing
            : html`<p class="stage-description">
                ${localize("components.install_progress.keep_window_open")}
              </p>`}
          <slot name="help"></slot>
        </div>
      </div>
    `;
  }

  private _toggleParts() {
    this._partsOpen = !this._partsOpen;
  }

  private _renderStage(stage: InstallStage, done: boolean) {
    return html`<li class="stage">
      <div class="row">
        <span
          class="status-dot ${done ? "completed" : ""}"
          aria-hidden="true"
        ></span>
        <span class="stage-label"
          >${stage.label}${done
            ? html`<span class="sr-only"
                >${` ${localize("components.install_progress.completed")}`}</span
              >`
            : nothing}</span
        >
      </div>
    </li>`;
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
