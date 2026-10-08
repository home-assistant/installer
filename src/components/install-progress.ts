import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { formatBytes } from "../api/index.js";
import {
  renderCasitaThinking,
  renderCasitaHappy,
  renderCasitaSad,
} from "./install-mascot.js";
import "./progress-bar.js";

export interface InstallStage {
  id: string;
  label: string;
}

@customElement("install-progress")
export class InstallProgress extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100%;
      padding-top: 110px;
      box-sizing: border-box;
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

    .casita-tear {
      animation: tear-fall 1.5s ease-in infinite;
    }

    .casita-tear.delay {
      animation-delay: 0.75s;
    }

    @keyframes tear-fall {
      0% {
        opacity: 0;
        transform: translateY(-4px);
      }
      20% {
        opacity: 1;
      }
      100% {
        opacity: 0;
        transform: translateY(12px);
      }
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
      margin: 0 0 1.5rem 0;
      max-width: 400px;
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

    .stage-status {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .stage-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: var(--ha-border-color, #e0e0e0);
      transition: background-color 0.3s ease;
    }

    @media (prefers-color-scheme: dark) {
      .stage-dot {
        background-color: var(--ha-border-color, #444444);
      }
    }

    .stage-dot.active {
      animation: pulse-dot 1s ease-in-out infinite;
    }

    @keyframes pulse-dot {
      0%,
      100% {
        background-color: var(--ha-primary-color, #03a9f4);
      }
      50% {
        background-color: var(--ha-border-color, #e0e0e0);
      }
    }

    .stage-dot.complete {
      background-color: var(--ha-primary-color, #03a9f4);
    }

    .thinking-cloud {
      position: absolute;
      top: -110px;
      right: -175px;
      width: 200px;
      height: 120px;
      z-index: 1;
    }

    @media (max-width: 600px) {
      .thinking-cloud {
        right: -40px;
      }
    }

    .thinking-cloud .cloud-text {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: white;
      font-size: 1.25rem;
      font-weight: 500;
      white-space: nowrap;
      z-index: 2;
    }

    .thinking-cloud .cloud-bump {
      position: absolute;
      background-color: #18bcf2;
      border-radius: 50%;
    }

    /* Build cloud shape from overlapping circles - like a real thought bubble */
    /* Left bump */
    .thinking-cloud .bump-1 {
      width: 70px;
      height: 70px;
      top: 30px;
      left: 0;
    }

    /* Top left bump */
    .thinking-cloud .bump-2 {
      width: 80px;
      height: 80px;
      top: 0;
      left: 25px;
    }

    /* Top center bump */
    .thinking-cloud .bump-3 {
      width: 90px;
      height: 85px;
      top: -5px;
      left: 70px;
    }

    /* Top right bump */
    .thinking-cloud .bump-4 {
      width: 75px;
      height: 75px;
      top: 5px;
      right: 10px;
    }

    /* Right bump */
    .thinking-cloud .bump-5 {
      width: 65px;
      height: 65px;
      top: 40px;
      right: 0;
    }

    /* Bottom right bump */
    .thinking-cloud .bump-6 {
      width: 70px;
      height: 70px;
      bottom: 0;
      right: 20px;
    }

    /* Bottom center bump */
    .thinking-cloud .bump-7 {
      width: 80px;
      height: 75px;
      bottom: -5px;
      left: 60px;
    }

    /* Bottom left bump */
    .thinking-cloud .bump-8 {
      width: 65px;
      height: 65px;
      bottom: 5px;
      left: 10px;
    }

    /* Center fill */
    .thinking-cloud .bump-center {
      width: 140px;
      height: 80px;
      border-radius: 50%;
      top: 20px;
      left: 30px;
    }

    .stage-description {
      font-size: 0.9375rem;
      font-weight: 400;
      color: var(--ha-secondary-text-color, #727272);
      margin: 0 0 1.5rem 0;
      text-align: center;
    }
  `;

  @property({ attribute: false }) stages: InstallStage[] = [];
  @property() stage = "downloading";
  @property() stageTitle = "Downloading";
  @property() description = "Installing Home Assistant";
  @property({ type: Number }) progress = 0;
  @property({ type: Number }) bytesProcessed = 0;
  @property({ type: Number }) totalBytes = 0;
  @property({ type: Number }) stageStartTime: number | null = null;
  @property({ type: Number }) stageStartBytes = 0;
  @property({ type: Boolean }) indeterminate = false;
  @property({ type: Boolean }) measurable = true;
  @property({ type: Boolean }) showUnknownBytes = false;
  @property({ type: Boolean }) hideEmptyDetails = false;
  @property({ attribute: false }) error: string | null = null;

  render() {
    if (this.error) {
      return html`
        <div class="mascot-container">${renderCasitaSad()}</div>
        <h2>Installation failed</h2>
        <p class="error-message">${this.error}</p>
      `;
    }
    const hasBubble = this.stage !== "complete" && this.stage !== "error";
    const currentIndex = this.stages.findIndex(
      (stage) => stage.id === this.stage
    );
    return html`
      <div class="mascot-container ${hasBubble ? "with-bubble" : ""}">
        ${this.stage === "complete"
          ? renderCasitaHappy()
          : this.stage === "error"
            ? renderCasitaSad()
            : renderCasitaThinking(this.stageTitle)}
      </div>
      <h2>${this.description}</h2>
      <ol class="stages-indicator" aria-label="Installation stages">
        ${this.stages.map(
          (stage, index) => html`
            <li
              class="stage"
              aria-current=${index === currentIndex ? "step" : nothing}
            >
              <span
                class="stage-dot ${this.stage === "complete" ||
                index < currentIndex
                  ? "complete"
                  : index === currentIndex
                    ? "active"
                    : ""}"
                aria-hidden="true"
              ></span>
              <span class="stage-label"
                >${stage.label}${this.stage === "complete" ||
                index < currentIndex
                  ? html`<span class="stage-status"> (completed)</span>`
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
        ></progress-bar>
        ${this.measurable || !this.hideEmptyDetails
          ? html`
              <div class="progress-details">
                <div class="progress-left">
                  <span class="bytes-info"
                    >${this.showUnknownBytes && this.indeterminate
                      ? formatBytes(this.bytesProcessed)
                      : this.measurable && this.totalBytes > 0
                        ? `${formatBytes(this.bytesProcessed)} / ${formatBytes(this.totalBytes)}${this.stage === "extracting" ? " compressed" : ""}`
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
                    >${this.measurable ? `${this.progress}%` : ""}</span
                  >
                  <span class="eta"
                    >${this.measurable && this.totalBytes > 0
                      ? this._calculateEta() || "Calculating..."
                      : ""}</span
                  >
                </div>
              </div>
            `
          : ""}
      </div>
      <p class="stage-description">
        Please keep this window open during installation
      </p>
    `;
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
      return "Less than a minute remaining";
    } else if (remainingSeconds < 3600) {
      const minutes = Math.ceil(remainingSeconds / 60);
      return `About ${minutes} minute${minutes !== 1 ? "s" : ""} remaining`;
    } else {
      const hours = Math.floor(remainingSeconds / 3600);
      const minutes = Math.ceil((remainingSeconds % 3600) / 60);
      return `About ${hours}h ${minutes}m remaining`;
    }
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

    return `${formatBytes(bytesPerSecond)}/s`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "install-progress": InstallProgress;
  }
}
