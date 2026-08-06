import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  wizardState,
  type WizardState,
  type WizardStep,
} from "../state/wizard-state.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "./step-indicator.js";

@customElement("wizard-shell")
export class WizardShell extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 2rem;
      border-bottom: 1px solid var(--ha-border-color, #e0e0e0);
    }

    @media (prefers-color-scheme: dark) {
      .header {
        border-bottom-color: var(--ha-border-color, #333333);
      }
    }

    .header-center {
      flex: 1;
      display: flex;
      justify-content: center;
    }

    .header-right {
      min-width: 80px;
    }

    .content {
      flex: 1;
      overflow-y: auto;
      padding: 2rem;
    }

    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 2rem;
      border-top: 1px solid var(--ha-border-color, #e0e0e0);
    }

    .footer-left {
      display: flex;
      gap: 1rem;
    }

    .footer-right {
      display: flex;
      gap: 1rem;
    }

    @media (prefers-color-scheme: dark) {
      .footer {
        border-top-color: var(--ha-border-color, #333333);
      }
    }
  `;

  @state()
  private _wizardState: WizardState = wizardState.getState();

  @property({ type: String })
  nextLabel = "Next";

  @property({ type: Boolean })
  nextDisabled = false;

  @property({ type: Boolean })
  hideBack = false;

  @property({ type: Boolean })
  hideNext = false;

  @property({ type: Boolean })
  hideFooter = false;

  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = wizardState.subscribe((state) => {
      this._wizardState = state;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  get steps(): WizardStep[] {
    return this._wizardState.steps;
  }

  get currentIndex(): number {
    return this._wizardState.currentStepIndex;
  }

  get isFirstStep(): boolean {
    return wizardState.isFirstStep;
  }

  get isLastStep(): boolean {
    return wizardState.isLastStep;
  }

  render() {
    return html`
      <div class="header">
        <wa-button
          appearance="plain"
          @click=${this._onBack}
          ?disabled=${this.isFirstStep || this.hideBack}
          style=${this.hideBack ? "visibility: hidden" : ""}
        >
          <span slot="start">←</span>
          Back
        </wa-button>

        <div class="header-center">
          <step-indicator
            .steps=${this.steps}
            .currentIndex=${this.currentIndex}
          ></step-indicator>
        </div>

        <div class="header-right"></div>
      </div>

      <div class="content">
        <slot></slot>
      </div>

      ${!this.hideFooter
        ? html`
            <div class="footer">
              <div class="footer-left">
                <wa-button appearance="plain" @click=${this._onCancel}>
                  Cancel
                </wa-button>
              </div>
              <div class="footer-right">
                ${!this.hideNext
                  ? html`
                      <wa-button
                        variant="brand"
                        appearance="accent"
                        @click=${this._onNext}
                        ?disabled=${this.nextDisabled}
                      >
                        ${this.nextLabel}
                      </wa-button>
                    `
                  : ""}
              </div>
            </div>
          `
        : ""}
    `;
  }

  private _onBack() {
    if (!this.isFirstStep) {
      wizardState.previousStep();
      this.dispatchEvent(
        new CustomEvent("wizard-back", {
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  private _onNext() {
    this.dispatchEvent(
      new CustomEvent("wizard-next", {
        bubbles: true,
        composed: true,
      })
    );
  }

  private _onCancel() {
    this.dispatchEvent(
      new CustomEvent("wizard-cancel", {
        bubbles: true,
        composed: true,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "wizard-shell": WizardShell;
  }
}
