import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { WizardStep } from "../state/wizard-state.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { localize } from "../localization/localize.js";

@customElement("step-indicator")
export class StepIndicator extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .steps {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .step {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .step-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background-color: var(--ha-border-color, #e0e0e0);
      transition: all 0.2s ease;
    }

    .step-dot.active {
      background-color: var(--ha-primary-color, #03a9f4);
      transform: scale(1.2);
    }

    .step-dot.completed {
      background-color: var(--ha-primary-color, #03a9f4);
    }

    .step-label {
      font-size: 0.875rem;
      color: var(--ha-secondary-text-color, #727272);
      transition: color 0.2s ease;
    }

    .step-label.active {
      color: var(--ha-text-color, #212121);
      font-weight: 500;
    }

    .step-status {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .step-connector {
      width: 24px;
      height: 2px;
      background-color: var(--ha-border-color, #e0e0e0);
      transition: background-color 0.2s ease;
    }

    .step-connector.completed {
      background-color: var(--ha-primary-color, #03a9f4);
    }

    @media (prefers-color-scheme: dark) {
      .step-dot {
        background-color: var(--ha-border-color, #444444);
      }

      .step-connector {
        background-color: var(--ha-border-color, #444444);
      }
    }

    /* Keep the other names in the accessibility tree when only the current
       one fits. */
    :host([compact]) .step-label:not(.active) {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }

    :host([compact]) .step-connector {
      width: 16px;
    }

    @media (max-width: 600px) {
      .step-label {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
      }
      .step-connector {
        width: 8px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      * {
        transition: none !important;
      }
    }
  `;

  @property({ type: Array })
  steps: WizardStep[] = [];

  @property({ type: Number })
  currentIndex = 0;

  private _fitFrame?: number;

  // Measuring in the observer callback would resize what it observes, so the
  // next frame does it, once however many resizes came in between
  private _resizeObserver = new ResizeObserver(() => {
    this._fitFrame ??= requestAnimationFrame(() => {
      this._fitFrame = undefined;
      this._fit();
    });
  });

  connectedCallback() {
    super.connectedCallback();
    this._resizeObserver.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver.disconnect();
    if (this._fitFrame !== undefined) cancelAnimationFrame(this._fitFrame);
    this._fitFrame = undefined;
  }

  protected updated(changed: PropertyValues) {
    if (changed.has("steps") || changed.has("currentIndex")) this._fit();
  }

  /**
   * Show every step name while they fit on one line. Otherwise only the
   * current one, so the steps never wrap and push the header taller.
   */
  private _fit() {
    const steps = this.renderRoot.querySelectorAll<HTMLElement>(".step");
    if (steps.length < 2) return;
    this.removeAttribute("compact");
    const first = steps[0];
    const last = steps[steps.length - 1];
    const wraps = last.offsetTop >= first.offsetTop + first.offsetHeight;
    this.toggleAttribute("compact", wraps);
  }

  render() {
    return html`
      <div
        class="steps"
        role="list"
        aria-label=${localize("components.step_indicator.installation_steps")}
      >
        ${this.steps.map((step, index) => this._renderStep(step, index))}
      </div>
    `;
  }

  private _renderStep(step: WizardStep, index: number) {
    const isActive = index === this.currentIndex;
    const isCompleted = index < this.currentIndex;
    const isLast = index === this.steps.length - 1;
    const status = isActive
      ? undefined
      : isCompleted
        ? localize("components.step_indicator.completed")
        : localize("components.step_indicator.upcoming");

    return html`
      <div
        class="step"
        role="listitem"
        aria-current=${ifDefined(isActive ? "step" : undefined)}
      >
        <span
          class="step-dot ${isActive ? "active" : ""} ${isCompleted
            ? "completed"
            : ""}"
          aria-hidden="true"
        ></span>
        <span class="step-label ${isActive ? "active" : ""}"
          >${step.title}${status
            ? html`<span class="step-status">${` ${status}`}</span>`
            : nothing}</span
        >
      </div>
      ${!isLast
        ? html`<span
            class="step-connector ${isCompleted ? "completed" : ""}"
            aria-hidden="true"
          ></span>`
        : ""}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "step-indicator": StepIndicator;
  }
}
