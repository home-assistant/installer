import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import "@home-assistant/webawesome/dist/components/dialog/dialog.js";
import "@home-assistant/webawesome/dist/components/button/button.js";

/**
 * Destructive confirmation dialog built on wa-dialog (focus trap, Escape,
 * backdrop dismiss, and role="dialog"/aria-modal come for free).
 *
 * Public API is unchanged: toggle `open`, set `driveName`, and listen for
 * `dialog-confirm` / `dialog-cancel`. Escape, backdrop click, and the header
 * close button all map to `dialog-cancel`.
 */
@customElement("confirm-dialog")
export class ConfirmDialog extends LitElement {
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
      --width: 32rem;
    }

    .dialog-title {
      display: inline-flex;
      align-items: center;
      gap: 0.75rem;
      color: var(--ha-error-color, #db4437);
    }

    .warning-icon {
      font-size: 1.5rem;
    }

    .dialog-message {
      font-size: 0.9375rem;
      color: var(--ha-text-color, #212121);
      line-height: 1.6;
      margin: 0 0 1rem 0;
    }

    .drive-name {
      font-weight: 600;
    }

    .password-note {
      font-size: 0.875rem;
      color: var(--ha-secondary-text-color, #727272);
      line-height: 1.5;
      margin: 0;
    }
  `;

  @property({ type: Boolean, reflect: true })
  open = false;

  @property({ type: String })
  driveName = "";

  render() {
    return html`
      <wa-dialog .open=${this.open} light-dismiss @wa-hide=${this._onWaHide}>
        <span slot="label" class="dialog-title">
          <span class="warning-icon">⚠️</span> Erase drive and install?
        </span>

        <p class="dialog-message">
          All data on <span class="drive-name">${this.driveName}</span> will be
          permanently erased. This action cannot be undone.
        </p>
        ${this._isMacOS()
          ? html`<p class="password-note">
              You will be prompted for your password to allow writing to the
              drive. This is required because writing to external drives needs
              administrator privileges.
            </p>`
          : ""}

        <wa-button slot="footer" appearance="outlined" @click=${this._onCancel}>
          Cancel
        </wa-button>
        <wa-button
          slot="footer"
          variant="danger"
          appearance="accent"
          @click=${this._onConfirm}
        >
          Erase and install
        </wa-button>
      </wa-dialog>
    `;
  }

  // Escape / backdrop / header close button. Guard against the wa-hide that
  // fires when an action button already closed the dialog (open is false by then).
  private _onWaHide() {
    if (!this.open) {
      return;
    }
    this.open = false;
    this._dispatch("dialog-cancel");
  }

  private _onCancel() {
    this.open = false;
    this._dispatch("dialog-cancel");
  }

  private _onConfirm() {
    this.open = false;
    this._dispatch("dialog-confirm");
  }

  private _dispatch(type: string) {
    this.dispatchEvent(
      new CustomEvent(type, { bubbles: true, composed: true })
    );
  }

  private _isMacOS(): boolean {
    return navigator.platform.toLowerCase().includes("mac");
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "confirm-dialog": ConfirmDialog;
  }
}
