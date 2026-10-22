import { localize } from "../localization/localize.js";
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  wizardState,
  type WizardState,
  type WizardStep,
} from "../state/wizard-state.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "./step-indicator.js";
import { pageHeaderStyles } from "../utils/page-header.js";

@customElement("wizard-shell")
export class WizardShell extends LitElement {
  static styles = [
    pageHeaderStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      .header {
        justify-content: space-between;
        border-bottom: 1px solid var(--ha-border-color, #e0e0e0);
      }

      @media (prefers-color-scheme: dark) {
        .header {
          border-bottom-color: var(--ha-border-color, #333333);
        }
      }

      .header-center {
        flex: 1;
        min-width: 0;
        display: flex;
        justify-content: center;
      }

      /* Its width is the room available, not its content, so it can tell when
         the step names stop fitting */
      step-indicator {
        flex: 1;
        min-width: 0;
      }

      .header-right {
        min-width: 80px;
      }

      @media (max-width: 600px) {
        .header-right {
          min-width: 0;
        }
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
    `,
  ];

  @state()
  private _wizardState: WizardState = wizardState.getState();

  @property({ type: String, attribute: "next-label" })
  nextLabel = localize("common.next");

  @property({ type: Boolean, attribute: "next-disabled" })
  nextDisabled = false;

  @property({ type: Boolean, attribute: "hide-back" })
  hideBack = false;

  @property({ type: Boolean, attribute: "hide-next" })
  hideNext = false;

  @property({ type: Boolean, attribute: "hide-cancel" })
  hideCancel = false;

  @property({ type: Boolean, attribute: "hide-footer" })
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
          ?disabled=${this.hideBack}
          style=${this.hideBack ? "visibility: hidden" : ""}
        >
          <span slot="start">←</span> ${localize("common.back")}
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
                ${this.hideCancel
                  ? nothing
                  : html`<wa-button appearance="plain" @click=${this._onCancel}>
                      ${localize("common.cancel")}
                    </wa-button>`}
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

  // Back and Next stay in place while the step under them changes, so the
  // second click of a double-click would act on the step it just opened:
  // a configured VM went straight past its confirmation into the install.
  // `detail` counts the clicks; keyboard activation reports 0.
  private _onBack(event: MouseEvent) {
    if (event.detail > 1) return;
    // On the first step, Back leaves the flow for the screen it was picked on
    if (this.isFirstStep) {
      this.dispatchEvent(
        new CustomEvent("wizard-exit", {
          bubbles: true,
          composed: true,
        })
      );
      return;
    }
    wizardState.previousStep();
    this.dispatchEvent(
      new CustomEvent("wizard-back", {
        bubbles: true,
        composed: true,
      })
    );
  }

  private _onNext(event: MouseEvent) {
    if (event.detail > 1) return;
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
