import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { checkConnection } from "../api/commands.js";
import { localize } from "../localization/localize.js";
import { installerError, renderErrorHelp } from "../utils/installer-error.js";
import { LatestRequest } from "../utils/latest-request.js";
import { linkStyles } from "../utils/link-styles.js";
import { fireEvent } from "../utils/fire-event.js";
import { renderRetryButton } from "../utils/load-state.js";
import { pageStyles, renderBackHeader } from "../utils/page-header.js";
import { ViewAccessibility } from "../utils/view-accessibility.js";
import "../components/casita-mascot.js";
import "../components/loading-spinner.js";

@customElement("connection-check-view")
export class ConnectionCheckView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    pageStyles,
    linkStyles,
    css`
      :host {
        text-align: center;
        color: var(--ha-text-color);
      }
      .content {
        gap: 1.5rem;
      }
      p {
        max-width: 32rem;
        overflow-wrap: anywhere;
        margin: 0;
        color: var(--ha-secondary-text-color);
      }
      .error-help {
        margin-top: 1rem;
      }
    `,
  ];

  @state() private _checking = false;
  @state() private _error = "";
  /** A check failed, so Try again stays, also while it checks again */
  @state() private _failed = false;
  private readonly _requests = new LatestRequest(this);

  connectedCallback() {
    super.connectedCallback();
    void this._check();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._checking = false;
  }

  private async _check() {
    if (this._checking) return;
    const request = this._requests.start();
    this._checking = true;
    this._error = "";
    try {
      await checkConnection();
      if (request.current) {
        fireEvent(this, "connection-ready");
      }
    } catch (error) {
      if (request.current) {
        this._error = installerError(error).message;
        this._failed = true;
      }
    } finally {
      if (request.latest) this._checking = false;
    }
  }

  render() {
    // The status stays in the DOM, so each change to it is announced. The
    // error takes the focus instead, which reads it out.
    return html`
      ${renderBackHeader(this._back)}
      <div class="content">
        ${this._checking
          ? html`<loading-spinner
              aria-label=${localize(
                "views.connection_check_view.checking_connection"
              )}
            ></loading-spinner>`
          : html`<casita-mascot mood="sad"></casita-mascot>`}
        <h1>
          ${this._checking
            ? localize("views.connection_check_view.checking_connection")
            : localize("views.connection_check_view.unable_to_connect")}
        </h1>
        <div>
          <p role="status">
            ${this._checking
              ? localize("views.connection_check_view.connecting")
              : ""}
          </p>
          <p data-focus-alert>${this._error}</p>
          ${this._failed ? renderErrorHelp() : ""}
        </div>
        ${this._failed
          ? renderRetryButton(this._checking, () => this._check())
          : ""}
      </div>
    `;
  }

  private _back() {
    this._requests.cancel();
    fireEvent(this, "connection-back");
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "connection-check-view": ConnectionCheckView;
  }

  interface HAIEvents {
    /** The connection works, so the flow can start */
    "connection-ready": undefined;
    "connection-back": undefined;
  }
}
