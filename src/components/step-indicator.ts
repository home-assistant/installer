import { LitElement, html, css } from "lit";
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

    /* Keep the names in the accessibility tree when only dots fit. */
    :host([compact]) .step-label {
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
        <span class="step-label ${isActive ? "active" : ""}">
          ${step.title}
        </span>
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
