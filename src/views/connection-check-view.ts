import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { checkConnection } from "../api/commands.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "@home-assistant/webawesome/dist/components/spinner/spinner.js";
const sadCasita = new URL("../assets/casita/Sad.svg", import.meta.url).href;

@customElement("connection-check-view")
export class ConnectionCheckView extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1.5rem;
      padding: 2rem;
      box-sizing: border-box;
      text-align: center;
      color: var(--ha-text-color, #212121);
    }
    img {
      width: 120px;
      height: 120px;
      object-fit: contain;
    }
    h2 {
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
    .actions {
      display: flex;
      gap: 1rem;
    }
  `;

  @state() private _checking = false;
  @state() private _error = "";
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
        this._error = String(error);
      }
    } finally {
      if (request === this._request) this._checking = false;
    }
  }

  render() {
    return html`
      ${this._checking
        ? html`<wa-spinner aria-label="Checking connection"></wa-spinner>`
        : html`<img src=${sadCasita} alt="" />`}
      <h2>${this._checking ? "Checking connection" : "Unable to connect"}</h2>
      <p role=${this._error ? "alert" : "status"}>
        ${this._error || "Connecting to Home Assistant's version service..."}
      </p>
      <div class="actions">
        <wa-button @click=${this._back}>Back</wa-button>
        ${this._error
          ? html`<wa-button variant="brand" @click=${this._check}
              >Retry</wa-button
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
