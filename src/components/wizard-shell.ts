import { localize } from "../localization/localize.js";
import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  wizardState,
  type WizardState,
  type WizardStep,
} from "../state/wizard-state.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "./step-indicator.js";
import { pageHeaderStyles } from "../utils/page-header.js";
import {
  dialogHasFocus,
  focusHeading,
  srOnlyStyles,
} from "../utils/view-accessibility.js";

/** The first heading in `root`, also in the shadow roots of its parts. */
function findHeading(root: ParentNode): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (element.matches("h1, h2")) return element;
    const heading = element.shadowRoot && findHeading(element.shadowRoot);
    if (heading) return heading;
  }
  return null;
}

@customElement("wizard-shell")
export class WizardShell extends LitElement {
  static styles = [
    pageHeaderStyles,
    srOnlyStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      .header {
        border-bottom: 1px solid var(--ha-border-color, #e0e0e0);
      }

      /* Its width is the room available, not its content, so it can tell when
         the step names stop fitting */
      step-indicator {
        flex: 1;
        min-width: 0;
      }

      .content {
        flex: 1;
        overflow-y: auto;
        padding: 2rem var(--ha-page-gutter, 2rem);
      }

      .footer {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 1rem var(--ha-page-gutter, 2rem);
        border-top: 1px solid var(--ha-border-color, #e0e0e0);
      }

      .footer-left {
        display: flex;
        gap: 1rem;
        margin-inline-end: auto;
      }

      .footer-right {
        display: flex;
        gap: 1rem;
      }

      /* Back points the way the page reads */
      .back [slot="start"]:dir(rtl) {
        transform: scaleX(-1);
      }

      /* Out of use, the buttons keep their place, so the step doesn't move */
      .footer.idle wa-button {
        visibility: hidden;
      }

      /* Busy, Next still says what it waits for, beside the spinner */
      wa-button[loading]::part(label) {
        opacity: 1;
      }

      wa-button[loading]::part(spinner) {
        position: static;
        order: -1;
        margin-inline-end: 0.5em;
      }
    `,
  ];

  @state()
  private _wizardState: WizardState = wizardState.getState();

  @property({ type: String, attribute: "next-label" })
  nextLabel = localize("common.next");

  @property({ type: Boolean, attribute: "next-disabled" })
  nextDisabled = false;

  /** Next waits for its step: it keeps the focus, but takes no clicks */
  @property({ type: Boolean, attribute: "next-busy" })
  nextBusy = false;

  @property({ type: Boolean, attribute: "hide-back" })
  hideBack = false;

  @property({ type: Boolean, attribute: "hide-next" })
  hideNext = false;

  @property({ type: Boolean, attribute: "hide-cancel" })
  hideCancel = false;

  /** Hides the footer's buttons; the footer itself stays */
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

  protected willUpdate(changed: PropertyValues<this>) {
    // A button that hides with the focus in it drops the focus to the page,
    // and a screen reader starts over from the top. Continue from the
    // heading of the step instead, as when it opened. A dialog gives the
    // focus back to the button that opened it, like Cancel for "Stop the
    // installation?", so the same goes for the focus in a dialog.
    if (
      changed.has("hideFooter") &&
      this.hideFooter &&
      (this.shadowRoot?.activeElement?.closest(".footer") || dialogHasFocus())
    ) {
      const step = this.firstElementChild;
      const heading = step && findHeading(step.shadowRoot ?? step);
      if (heading) focusHeading(heading);
    }
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
        <step-indicator
          .steps=${this.steps}
          .currentIndex=${this.currentIndex}
        ></step-indicator>
      </div>

      <div class="content">
        <slot></slot>
      </div>

      <div class="footer ${this.hideFooter ? "idle" : ""}">
        <div class="footer-left">
          ${this.hideCancel
            ? nothing
            : html`<wa-button appearance="plain" @click=${this._onCancel}>
                ${localize("common.cancel")}
              </wa-button>`}
        </div>
        <wa-button
          class="back"
          appearance="plain"
          @click=${this._onBack}
          ?disabled=${this.hideBack}
          style=${this.hideBack ? "visibility: hidden" : ""}
        >
          <span slot="start">←</span> ${localize("common.back")}
        </wa-button>
        <div class="footer-right">
          <!-- A new label on the focused button isn't always read out -->
          <span class="sr-only" aria-live="polite"
            >${this.nextBusy ? this.nextLabel : ""}</span
          >
          ${!this.hideNext
            ? html`
                <wa-button
                  variant="brand"
                  appearance="accent"
                  @click=${this._onNext}
                  ?disabled=${this.nextDisabled}
                  ?loading=${this.nextBusy}
                >
                  ${this.nextLabel}
                </wa-button>
              `
            : ""}
        </div>
      </div>
    `;
  }

  private _onBack() {
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
