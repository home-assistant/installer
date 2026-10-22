import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { customElement, property, queryAll } from "lit/decorators.js";
import type { WizardStep } from "../state/wizard-state.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { localize } from "../localization/localize.js";
import {
  reducedMotionStyles,
  srOnlyStyles,
} from "../utils/view-accessibility.js";

@customElement("step-indicator")
export class StepIndicator extends LitElement {
  static styles = [
    srOnlyStyles,
    reducedMotionStyles,
    css`
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

      /* Each state has its own shape, not only its own color: upcoming is an
         empty ring, completed a filled dot, current a filled dot in a ring */
      .step-dot {
        box-sizing: border-box;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        border: 2px solid var(--ha-inactive-color, #8c8c8c);
        transition: all 0.2s ease;
      }

      .step-dot.active,
      .step-dot.completed {
        border-color: var(--ha-primary-color, #03a9f4);
        background-color: var(--ha-primary-color, #03a9f4);
      }

      .step-dot.active {
        outline: 2px solid var(--ha-primary-color, #03a9f4);
        outline-offset: 2px;
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

      .step-connector {
        width: 24px;
        height: 2px;
        background-color: var(--ha-inactive-color, #8c8c8c);
        transition: background-color 0.2s ease;
      }

      .step-connector.completed {
        background-color: var(--ha-primary-color, #03a9f4);
      }

      /* Forced colors would paint the fills like the page, leaving the
         completed dots as empty as the upcoming ones */
      @media (forced-colors: active) {
        .step-dot {
          border-color: GrayText;
        }

        .step-dot.completed {
          border-color: CanvasText;
          background-color: CanvasText;
        }

        .step-dot.active {
          border-color: Highlight;
          background-color: Highlight;
          outline-color: Highlight;
        }

        .step-connector {
          background-color: GrayText;
        }

        .step-connector.completed {
          background-color: CanvasText;
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
    `,
  ];

  @property({ type: Array })
  steps: WizardStep[] = [];

  @property({ type: Number, attribute: "current-index" })
  currentIndex = 0;

  @queryAll(".step")
  private _steps!: NodeListOf<HTMLElement>;

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
    const steps = this._steps;
    const first = steps[0];
    const last = steps[steps.length - 1];
    if (!first || !last || first === last) return;
    this.removeAttribute("compact");
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
            ? html`<span class="sr-only">${` ${status}`}</span>`
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
