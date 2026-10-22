import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { checkConnection } from "../api/commands.js";
import { localize } from "../localization/localize.js";
import { installerError } from "../utils/installer-error.js";
import { pageHeaderStyles, renderBackHeader } from "../utils/page-header.js";
import { ViewAccessibility } from "../utils/view-accessibility.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "@home-assistant/webawesome/dist/components/spinner/spinner.js";
import "../components/casita-mascot.js";

@customElement("connection-check-view")
export class ConnectionCheckView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    pageHeaderStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        height: 100%;
        text-align: center;
        color: var(--ha-text-color, #212121);
      }
      .content {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1.5rem;
        overflow-y: auto;
        padding: 1rem var(--ha-page-gutter, 2rem) 2rem;
      }
      /* The auto margins center the status while it fits; once it doesn't,
         it scrolls from the top instead of being cut off */
      .content > :first-child {
        margin-top: auto;
      }
      .content > :last-child {
        margin-bottom: auto;
      }
      h1 {
        font-size: 1.5rem;
        font-weight: 400;
        margin: 0;
      }
      p {
        max-width: 32rem;
        overflow-wrap: anywhere;
        margin: 0;
        color: var(--ha-secondary-text-color, #727272);
      }
    `,
  ];

  @state() private _checking = false;
  @state() private _error = "";
  /** A check failed, so Retry stays, also while it checks again */
  @state() private _failed = false;
  private _request = 0;

  connectedCallback() {
    super.connectedCallback();
    void this._check();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._request++;
    this._checking = false;
  }

  private async _check() {
    if (this._checking) return;
    const request = ++this._request;
    this._checking = true;
    this._error = "";
    try {
      await checkConnection();
      if (this.isConnected && request === this._request) {
        this.dispatchEvent(new CustomEvent("connection-ready"));
      }
    } catch (error) {
      if (this.isConnected && request === this._request) {
        this._error = installerError(error).message;
        this._failed = true;
      }
    } finally {
      if (request === this._request) this._checking = false;
    }
  }

  render() {
    // Both regions stay in the DOM, so a change to either is announced
    return html`
      ${renderBackHeader(this._back)}
      <div class="content">
        ${this._checking
          ? html`<wa-spinner
              aria-label=${localize(
                "views.connection_check_view.checking_connection"
              )}
            ></wa-spinner>`
          : html`<casita-mascot mood="sad"></casita-mascot>`}
        <h1>
          ${this._checking
            ? localize("views.connection_check_view.checking_connection")
            : localize("views.connection_check_view.unable_to_connect")}
        </h1>
        <div>
          <p role="status">
            ${this._checking
              ? localize(
                  "views.connection_check_view.connecting_to_home_assistant_s_version_service"
                )
              : ""}
          </p>
          <p role="alert">${this._error}</p>
        </div>
        ${this._failed
          ? html`<wa-button
              variant="brand"
              ?loading=${this._checking}
              @click=${this._check}
              >${localize("views.connection_check_view.retry")}</wa-button
            >`
          : ""}
      </div>
    `;
  }

  private _back() {
    this._request++;
    this.dispatchEvent(new CustomEvent("connection-back"));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "connection-check-view": ConnectionCheckView;
  }
}
