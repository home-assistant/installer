import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import "@home-assistant/webawesome/dist/components/dialog/dialog.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import { formatBytes } from "../api/index.js";

/**
 * Destructive confirmation dialog built on wa-dialog (focus trap, Escape,
 * backdrop dismiss, and role="dialog"/aria-modal come for free).
 *
 * Toggle `open`, describe the target with `driveName` / `drivePath` /
 * `driveModel` / `driveSize`, and listen for `dialog-confirm` /
 * `dialog-cancel`. Escape, backdrop click, and the header close button all
 * map to `dialog-cancel`.
 *
 * The device path is shown because it is the one value actually sent to the
 * backend, and it is the only thing that tells two otherwise identical cards
 * apart at the point of no return.
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

    .drive-details {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.375rem 1rem;
      padding: 0.75rem 1rem;
      margin: 0 0 1rem 0;
      background-color: var(--ha-background-color, #f5f5f5);
      border: 1px solid var(--ha-border-color, #e0e0e0);
      border-radius: 8px;
      font-size: 0.875rem;
    }

    @media (prefers-color-scheme: dark) {
      .drive-details {
        background-color: var(--ha-card-background, #1e1e1e);
        border-color: var(--ha-border-color, #333333);
      }
    }

    .detail-label {
      color: var(--ha-secondary-text-color, #727272);
      margin: 0;
    }

    .detail-value {
      color: var(--ha-text-color, #212121);
      margin: 0;
      font-weight: 500;
      overflow-wrap: anywhere;
    }

    .detail-value.path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
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

  /** Device id/path handed to the backend, e.g. "/dev/sda" or "disk2". */
  @property({ type: String })
  drivePath = "";

  @property({ type: String })
  driveModel = "";

  @property({ type: Number })
  driveSize = 0;

  render() {
    return html`
      <wa-dialog
        .open=${this.open}
        light-dismiss
        @wa-after-hide=${this._onAfterHide}
      >
        <span slot="label" class="dialog-title">
          <span class="warning-icon">⚠️</span> Erase drive and install?
        </span>

        <p class="dialog-message">
          All data on <span class="drive-name">${this.driveName}</span> will be
          permanently erased. This action cannot be undone.
        </p>

        ${this._renderDriveDetails()}
        ${this._promptsForPassword()
          ? html`<p class="password-note">
              You may be prompted for your password to allow writing to the
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

  private _renderDriveDetails() {
    if (!this.drivePath && !this.driveModel && !this.driveSize) {
      return "";
    }

    return html`
      <dl class="drive-details">
        ${this.drivePath
          ? html`
              <dt class="detail-label">Device</dt>
              <dd class="detail-value path">${this.drivePath}</dd>
            `
          : ""}
        ${this.driveModel
          ? html`
              <dt class="detail-label">Model</dt>
              <dd class="detail-value">${this.driveModel}</dd>
            `
          : ""}
        ${this.driveSize
          ? html`
              <dt class="detail-label">Size</dt>
              <dd class="detail-value">${formatBytes(this.driveSize)}</dd>
            `
          : ""}
      </dl>
    `;
  }

  // Fires after the dialog has fully closed (Escape / backdrop / header close
  // button). Syncing here rather than on wa-hide avoids feeding open=false back
  // into wa-dialog mid-animation, which would trigger a second close request.
  private _onAfterHide(event: Event) {
    // wa-after-hide bubbles and is composed, so ignore events re-dispatched
    // from any nested Web Awesome overlay in the dialog body.
    if (event.eventPhase !== Event.AT_TARGET) {
      return;
    }
    // open=false already means an action button or the consumer closed us,
    // so this hide is not a user dismissal.
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

  // macOS asks for admin credentials via Authorization Services; Linux raises
  // a polkit prompt through udisks2. Windows requires launching elevated, so
  // there is no in-flow prompt to announce.
  private _promptsForPassword(): boolean {
    const platform = navigator.platform.toLowerCase();
    return platform.includes("mac") || platform.includes("linux");
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "confirm-dialog": ConfirmDialog;
  }
}
