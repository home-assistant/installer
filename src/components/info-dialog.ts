import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import "@home-assistant/webawesome/dist/components/dialog/dialog.js";
import "@home-assistant/webawesome/dist/components/button/button.js";

/**
 * Informational dialog built on wa-dialog (focus trap, Escape, backdrop
 * dismiss, and role="dialog"/aria-modal come for free).
 *
 * Public API is unchanged: toggle `open`, set `title` / `message` /
 * `primaryLabel` / `secondaryLabel`, and listen for `dialog-primary` /
 * `dialog-secondary`. Escape, backdrop click, and the header close button all
 * map to `dialog-secondary` (dismiss).
 */
@customElement("info-dialog")
export class InfoDialog extends LitElement {
  static styles = css`
    :host {
      display: none;
    }

    /* When open, occupy the viewport so the host is a real (if transparent)
       box. wa-dialog renders a native modal in the top layer above this, which
       handles all interaction; this just gives the host a layout box. */
    :host([open]) {
      display: block;
      position: fixed;
      inset: 0;
    }

    wa-dialog {
      --width: 30rem;
    }

    .dialog-title {
      display: inline-flex;
      align-items: center;
      gap: 0.75rem;
      color: var(--ha-text-color, #212121);
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

    .dialog-message {
      font-size: 0.9375rem;
      color: var(--ha-text-color, #212121);
      line-height: 1.6;
      margin: 0;
    }
  `;

  @property({ type: Boolean, reflect: true })
  open = false;

  @property({ type: String })
  title = "";

  @property({ type: String })
  message = "";

  @property({ type: String })
  primaryLabel = "OK";

  @property({ type: String })
  secondaryLabel = "";

  // Set when an action button closes the dialog, so the subsequent
  // wa-after-hide doesn't also emit a dismiss (dialog-secondary) event.
  private _closingViaAction = false;

  render() {
    return html`
      <wa-dialog
        .open=${this.open}
        light-dismiss
        @wa-after-hide=${this._onAfterHide}
      >
        <span slot="label" class="dialog-title">
          <span class="info-icon">
            <svg viewBox="0 0 24 24">
              <path
                d="M13,9H11V7H13M13,17H11V11H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z"
              />
            </svg>
          </span>
          ${this.title}
        </span>

        <p class="dialog-message">${this.message}</p>
        <slot></slot>

        ${this.secondaryLabel
          ? html`
              <wa-button
                slot="footer"
                appearance="outlined"
                @click=${this._onSecondary}
              >
                ${this.secondaryLabel}
              </wa-button>
            `
          : ""}
        <wa-button
          slot="footer"
          variant="brand"
          appearance="accent"
          @click=${this._onPrimary}
        >
          ${this.primaryLabel}
        </wa-button>
      </wa-dialog>
    `;
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
    if (this._closingViaAction) {
      this._closingViaAction = false;
      return;
    }
    this.open = false;
    this._dispatch("dialog-secondary");
  }

  private _onSecondary() {
    this._closingViaAction = true;
    this.open = false;
    this._dispatch("dialog-secondary");
  }

  private _onPrimary() {
    this._closingViaAction = true;
    this.open = false;
    this._dispatch("dialog-primary");
  }

  private _dispatch(type: string) {
    this.dispatchEvent(
      new CustomEvent(type, { bubbles: true, composed: true })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "info-dialog": InfoDialog;
  }
}
