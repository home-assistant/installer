import { localize } from "../localization/localize.js";
import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import {
  wizardState,
  type WizardState,
  type WizardStep,
} from "../state/wizard-state.js";
import { WizardStateController } from "../state/wizard-state-controller.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "./step-indicator.js";
import { pageHeaderStyles } from "../utils/page-header.js";
import { lowWindow, narrowWindow } from "../utils/breakpoints.js";
import { fireEvent } from "../utils/fire-event.js";
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
        justify-content: space-between;
        border-bottom: 1px solid var(--ha-border-color);
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

      @media ${narrowWindow} {
        .header-right {
          min-width: 0;
        }
      }

      .content {
        flex: 1;
        overflow-y: auto;
        padding: 2rem var(--ha-page-gutter);
      }

      .footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 1rem var(--ha-page-gutter);
        border-top: 1px solid var(--ha-border-color);
      }

      .footer-left {
        display: flex;
        gap: 1rem;
      }

      .footer-right {
        display: flex;
        gap: 1rem;
      }

      /* Thinner on a low window, like the header. Cancel and Next have no
         step name beside them, so unlike Back they get lower too; their text
         keeps its size. */
      @media ${lowWindow} {
        .footer {
          padding-block: 0.5rem;
        }

        .footer wa-button {
          --wa-form-control-height: 2.25em;
        }
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

  private readonly _wizard = new WizardStateController(this);

  private get _wizardState(): WizardState {
    return this._wizard.state;
  }

  /** Whether the step is larger than the window, so it can be scrolled */
  @state()
  private _scrolls = false;

  private _resizeObserver = new ResizeObserver(() => this._checkScrolling());

  @query(".content")
  private _content?: HTMLElement;

  @query("slot")
  private _slot?: HTMLSlotElement;

  /** What is being installed, as the page's main heading */
  @property({ type: String, attribute: "flow-title" })
  flowTitle = "";

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

  connectedCallback() {
    super.connectedCallback();
    // Put back in the page with the same step, the slot doesn't change
    if (this.hasUpdated) this._observeContent();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver.disconnect();
  }

  // A keyboard can only scroll what it can focus, and some steps have
  // nothing focusable in them. Only when they overflow, so it isn't an
  // extra tab stop on every step. A step is at least as tall as the content
  // area and grows with what it shows, so its size and the area's say when.
  private _observeContent() {
    if (!this._content || !this._slot) return;
    this._resizeObserver.disconnect();
    this._resizeObserver.observe(this._content);
    for (const element of this._slot.assignedElements()) {
      this._resizeObserver.observe(element);
    }
  }

  private _checkScrolling() {
    const content = this._content;
    // Both are rounded, so at a fractional size the content can measure a
    // pixel more than its box without scrolling
    this._scrolls =
      !!content &&
      (content.scrollHeight - content.clientHeight > 1 ||
        content.scrollWidth - content.clientWidth > 1);
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

  render() {
    return html`
      <header class="header">
        <wa-button
          appearance="plain"
          @click=${this._onBack}
          ?disabled=${this.hideBack}
          style=${this.hideBack ? "visibility: hidden" : ""}
        >
          <span slot="start" aria-hidden="true">←</span>
          ${localize("common.back")}
        </wa-button>

        <div class="header-center">
          <step-indicator
            .steps=${this.steps}
            .currentIndex=${this.currentIndex}
          ></step-indicator>
        </div>

        <div class="header-right"></div>
      </header>

      <main class="content" tabindex=${this._scrolls ? "0" : nothing}>
        ${this.flowTitle
          ? html`<h1 class="sr-only">${this.flowTitle}</h1>`
          : nothing}
        <slot @slotchange=${this._observeContent}></slot>
      </main>

      <footer class="footer ${this.hideFooter ? "idle" : ""}">
        <div class="footer-left">
          ${this.hideCancel
            ? nothing
            : html`<wa-button appearance="plain" @click=${this._onCancel}>
                ${localize("common.cancel")}
              </wa-button>`}
        </div>
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
      </footer>
    `;
  }

  private _onBack() {
    // On the first step, Back leaves the flow for the screen it was picked on
    if (this.isFirstStep) {
      fireEvent(this, "wizard-exit");
      return;
    }
    wizardState.previousStep();
    fireEvent(this, "wizard-back");
  }

  private _onNext() {
    fireEvent(this, "wizard-next");
  }

  private _onCancel() {
    fireEvent(this, "wizard-cancel");
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "wizard-shell": WizardShell;
  }

  interface HAIEvents {
    /** Back on the first step, which leaves the flow */
    "wizard-exit": undefined;
    "wizard-back": undefined;
    /** Next, or a step's view moving on the way Next does */
    "wizard-next": undefined;
    "wizard-cancel": undefined;
  }
}
