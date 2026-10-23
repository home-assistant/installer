import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { customElement, property, query, queryAll } from "lit/decorators.js";
import type { WizardStep } from "../state/wizard-state.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { localize } from "../localization/localize.js";
import {
  reducedMotionStyles,
  srOnlyStyles,
} from "../utils/view-accessibility.js";
import { statusDotStyles } from "../utils/status-dot-styles.js";

@customElement("step-indicator")
export class StepIndicator extends LitElement {
  static styles = [
    srOnlyStyles,
    reducedMotionStyles,
    statusDotStyles,
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

      .status-dot {
        flex-shrink: 0;
        transition: all 0.2s ease;
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
        flex-shrink: 0;
        width: 24px;
        height: 2px;
        background-color: var(--ha-inactive-color, #8c8c8c);
        transition: background-color 0.2s ease;
      }

      .step-connector.completed {
        background-color: var(--ha-primary-color, #03a9f4);
      }

      /* Forced colors would paint the lines like the page, out of sight */
      @media (forced-colors: active) {
        .step-connector {
          background-color: GrayText;
        }

        .step-connector.completed {
          background-color: CanvasText;
        }
      }

      /* The current name takes the room the dots leave, and wraps there
         rather than pushing steps onto a line of their own */
      :host([compact]) .steps {
        flex-wrap: nowrap;
      }

      :host([compact]) .step-label.active {
        overflow-wrap: anywhere;
      }

      :host([compact]) .step-connector {
        width: 16px;
      }

      @media (max-width: 600px) {
        .steps {
          gap: 0.25rem;
        }

        /* Its ring reaches as far as the gap, and would touch the lines */
        .status-dot.active {
          margin-inline: 2px;
        }

        .step-connector,
        :host([compact]) .step-connector {
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

  @queryAll(".step-label")
  private _labels!: NodeListOf<HTMLElement>;

  @query(".step-label.active")
  private _currentLabel!: HTMLElement | null;

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
    this._setCompact(false);
    const wraps = last.offsetTop >= first.offsetTop + first.offsetHeight;
    this._setCompact(wraps);
    if (wraps && this._currentLabel) this._hug(this._currentLabel);
  }

  // Hidden, the other names stay in the accessibility tree. Rendering a
  // label's class anew drops `sr-only`, and `updated` fits the steps again.
  private _setCompact(compact: boolean) {
    this.toggleAttribute("compact", compact);
    for (const label of this._labels) {
      label.classList.toggle(
        "sr-only",
        compact && !label.classList.contains("active")
      );
      label.style.width = "";
    }
  }

  /**
   * A name that wraps keeps all the room it was given, beside its shorter
   * lines too. Narrow it to its longest line, so the next dot follows it.
   */
  private _hug(label: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(label);
    const lines = [...range.getClientRects()];
    if (lines.length < 2) return;
    const start = Math.min(...lines.map((line) => line.left));
    const end = Math.max(...lines.map((line) => line.right));
    label.style.width = `${Math.ceil(end - start)}px`;
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
          class="status-dot ${isActive ? "active" : ""} ${isCompleted
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
