import { LitElement, html, css, type CSSResultGroup } from "lit";
import { property } from "lit/decorators.js";
import "@home-assistant/webawesome/dist/components/dialog/dialog.js";
import { dialogStyles } from "../utils/dialog-styles.js";

/**
 * How a dialog was closed: with its main action, or any other way. Escape,
 * backdrop click, and the header close button count as the other way.
 */
export type DialogChoice = "dialog-primary" | "dialog-secondary";

/**
 * A dialog built on wa-dialog (focus trap, Escape, backdrop dismiss, and
 * role="dialog"/aria-modal come for free) that reports how it was closed.
 *
 * Toggle `open`, and listen for `dialog-primary` / `dialog-secondary`. The
 * main action button calls `choose("dialog-primary")` and the other one
 * `choose("dialog-secondary")`, so every dialog reports the same two events.
 */
export abstract class DialogBase extends LitElement {
  static styles: CSSResultGroup = [
    dialogStyles,
    css`
      :host {
        display: none;
      }

      /* While open, occupy the viewport so the host is a real (if
         transparent) box. wa-dialog renders a native modal in the top layer
         above this, which handles all interaction; this just gives the host a
         layout box. It stays until wa-dialog has animated out: hiding the
         host hides the dialog in it at once. */
      :host([open]),
      :host([closing]) {
        display: block;
        position: fixed;
        inset: 0;
      }

      .dialog-title {
        display: inline-flex;
        align-items: center;
        gap: 0.75rem;
        color: var(--ha-text-color, #212121);
      }

      .dialog-title.warning {
        color: var(--ha-error-color, #db4437);
      }

      .info-icon {
        width: 1.5rem;
        height: 1.5rem;
        flex-shrink: 0;
      }

      .info-icon svg {
        width: 100%;
        height: 100%;
        fill: var(--ha-primary-color, #03a9f4);
      }

      .warning-icon {
        font-size: 1.5rem;
      }

      .dialog-message {
        font-size: 0.9375rem;
        color: var(--ha-text-color, #212121);
        line-height: 1.6;
        margin: 0;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true })
  open = false;

  /** From wa-dialog starting to animate out until it has */
  private _closing = false;

  /** The label, body and footer buttons inside the wa-dialog */
  protected abstract renderContent(): unknown;

  render() {
    return html`
      <wa-dialog
        .open=${this.open}
        light-dismiss
        @wa-hide=${this._onHide}
        @wa-after-hide=${this._onAfterHide}
      >
        ${this.renderContent()}
      </wa-dialog>
    `;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // Removed while animating out, so no wa-after-hide will come
    this._setClosing(false);
  }

  /**
   * The title in the label slot. A warning one for a dialog whose action
   * can't be undone. The icon is decorative: the heading says what it asks.
   */
  protected renderTitle(heading: unknown, tone: "info" | "warning" = "info") {
    return html`
      <span slot="label" class="dialog-title ${tone}">
        ${tone === "warning"
          ? html`<span class="warning-icon" aria-hidden="true">⚠️</span>`
          : html`<span class="info-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path
                  d="M13,9H11V7H13M13,17H11V11H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z"
                />
              </svg>
            </span>`}
        ${heading}
      </span>
    `;
  }

  /**
   * Closes the dialog and reports `type`. Only the first way out counts: a
   * second click, or a click after Escape while the dialog animates out,
   * reports nothing.
   */
  protected choose(type: DialogChoice) {
    if (!this.open || this._closing) return;
    this.open = false;
    this._dispatch(type);
  }

  private _onHide(event: Event) {
    // wa-hide bubbles and is composed, so ignore events re-dispatched from
    // any nested Web Awesome overlay slotted into the dialog body.
    if (event.eventPhase !== Event.AT_TARGET) {
      return;
    }
    this._setClosing(true);
  }

  // Fires after the dialog has fully closed (Escape / backdrop / header close
  // button). Syncing here rather than on wa-hide avoids feeding open=false back
  // into wa-dialog mid-animation, which would trigger a second close request.
  private _onAfterHide(event: Event) {
    // wa-after-hide bubbles and is composed, so ignore events re-dispatched
    // from any nested Web Awesome overlay slotted into the dialog body.
    if (event.eventPhase !== Event.AT_TARGET) {
      return;
    }
    this._setClosing(false);
    // open=false already means an action button or the consumer closed us,
    // so this hide is not a user dismissal.
    if (!this.open) {
      return;
    }
    this.open = false;
    this._dispatch("dialog-secondary");
  }

  private _setClosing(closing: boolean) {
    this._closing = closing;
    this.toggleAttribute("closing", closing);
  }

  private _dispatch(type: DialogChoice) {
    this.dispatchEvent(
      new CustomEvent(type, { bubbles: true, composed: true })
    );
  }
}
