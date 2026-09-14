import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import "@home-assistant/webawesome/dist/components/dialog/dialog.js";
import "@home-assistant/webawesome/dist/components/button/button.js";

/**
 * Asks the user to confirm a Proxmox server's TLS certificate fingerprint.
 *
 * A default Proxmox VE install serves a self-signed certificate that no CA
 * vouches for, so the user is the only one who can say whether it is the right
 * one. This is shown before any password is sent, and the answer decides
 * whether the fingerprint gets pinned for later connections.
 *
 * Built on wa-dialog like `confirm-dialog`, and follows the same contract:
 * toggle `open`, then listen for `dialog-confirm` / `dialog-cancel`. Escape,
 * backdrop click, and the header close button all map to `dialog-cancel`, so
 * dismissing the dialog never trusts anything.
 */
@customElement("certificate-trust-dialog")
export class CertificateTrustDialog extends LitElement {
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
      --width: 34rem;
    }

    .dialog-title {
      display: inline-flex;
      align-items: center;
      gap: 0.75rem;
    }

    .dialog-title.changed {
      color: var(--ha-error-color, #db4437);
    }

    .title-icon {
      font-size: 1.5rem;
    }

    .dialog-message {
      font-size: 0.9375rem;
      color: var(--ha-text-color, #212121);
      line-height: 1.6;
      margin: 0 0 1rem 0;
    }

    .server {
      font-weight: 600;
    }

    .fingerprint-label {
      font-size: 0.75rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--ha-secondary-text-color, #727272);
      margin: 0 0 0.375rem 0;
    }

    .fingerprint {
      font-family:
        ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      font-size: 0.8125rem;
      line-height: 1.7;
      /* The user compares this character by character, so let it wrap
         anywhere rather than scroll out of view. */
      overflow-wrap: anywhere;
      user-select: all;
      padding: 0.625rem 0.75rem;
      border-radius: 8px;
      background-color: var(--ha-background-color, #f5f5f5);
      border: 1px solid var(--ha-border-color, #e0e0e0);
      margin: 0 0 1rem 0;
    }

    .fingerprint.previous {
      color: var(--ha-secondary-text-color, #727272);
    }

    @media (prefers-color-scheme: dark) {
      .fingerprint {
        background-color: var(--ha-background-color, #121212);
        border-color: var(--ha-border-color, #333333);
      }
    }

    .where-to-check {
      font-size: 0.875rem;
      color: var(--ha-secondary-text-color, #727272);
      line-height: 1.6;
      margin: 0;
    }

    .where-to-check ul {
      margin: 0.375rem 0 0 0;
      padding-left: 1.25rem;
    }

    code {
      font-family:
        ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      font-size: 0.8125rem;
    }

    .warning {
      font-size: 0.9375rem;
      color: var(--ha-text-color, #212121);
      line-height: 1.6;
      margin: 0 0 1rem 0;
      padding: 0.75rem;
      border-radius: 8px;
      background-color: rgba(244, 67, 54, 0.1);
      border: 1px solid rgba(244, 67, 54, 0.3);
    }
  `;

  @property({ type: Boolean, reflect: true })
  open = false;

  /** The server the certificate belongs to, as host:port. */
  @property({ type: String })
  server = "";

  /** SHA-256 fingerprint the server presented. */
  @property({ type: String })
  fingerprint = "";

  /**
   * The fingerprint that was pinned previously. When set, the certificate has
   * changed since it was trusted, which needs a much stronger warning.
   */
  @property({ type: String })
  previousFingerprint = "";

  private get _changed(): boolean {
    return this.previousFingerprint !== "";
  }

  render() {
    return html`
      <wa-dialog
        .open=${this.open}
        light-dismiss
        @wa-after-hide=${this._onAfterHide}
      >
        <span
          slot="label"
          class="dialog-title ${this._changed ? "changed" : ""}"
        >
          <span class="title-icon">${this._changed ? "⚠️" : "🔐"}</span>
          ${this._changed
            ? "Certificate has changed"
            : "Is this the right server?"}
        </span>

        ${this._changed ? this._renderChanged() : this._renderFirstContact()}

        <wa-button slot="footer" appearance="outlined" @click=${this._onCancel}>
          Cancel
        </wa-button>
        <wa-button
          slot="footer"
          variant=${this._changed ? "danger" : "brand"}
          appearance="accent"
          @click=${this._onConfirm}
        >
          ${this._changed ? "Trust the new certificate" : "Trust and connect"}
        </wa-button>
      </wa-dialog>
    `;
  }

  private _renderFirstContact() {
    return html`
      <p class="dialog-message">
        <span class="server">${this.server}</span> identifies itself with the
        certificate below. Proxmox creates this certificate itself, so nothing
        else can confirm it belongs to your server — please check it matches
        before your password is sent.
      </p>

      <p class="fingerprint-label">SHA-256 fingerprint</p>
      <p class="fingerprint">${this.fingerprint}</p>

      ${this._renderWhereToCheck()}
    `;
  }

  private _renderChanged() {
    return html`
      <p class="warning">
        <span class="server">${this.server}</span> is now using a different
        certificate than the one you trusted. If you did not renew or replace it
        yourself, someone may be intercepting this connection — do not continue.
      </p>

      <p class="fingerprint-label">Now presented</p>
      <p class="fingerprint">${this.fingerprint}</p>

      <p class="fingerprint-label">Previously trusted</p>
      <p class="fingerprint previous">${this.previousFingerprint}</p>

      ${this._renderWhereToCheck()}
    `;
  }

  private _renderWhereToCheck() {
    return html`
      <div class="where-to-check">
        Proxmox shows the same fingerprint in:
        <ul>
          <li>Datacenter → your node → Certificates, under pveproxy-ssl.pem</li>
          <li>the output of <code>pvenode cert info</code> on the node</li>
        </ul>
      </div>
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
}

declare global {
  interface HTMLElementTagNameMap {
    "certificate-trust-dialog": CertificateTrustDialog;
  }
}
