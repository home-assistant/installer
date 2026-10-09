import {
  installerError,
  renderErrorHelp,
  type InstallerError,
} from "../../utils/installer-error.js";
import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { InstallDiagnostics } from "../../utils/diagnostics.js";
import { customElement, state } from "lit/decorators.js";
import {
  proxmoxCertificateFingerprint,
  proxmoxConnect,
} from "../../api/commands.js";
import { wizardState } from "../../state/wizard-state.js";
import "@home-assistant/webawesome/dist/components/callout/callout.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import "@home-assistant/webawesome/dist/components/input/input.js";
import "@home-assistant/webawesome/dist/components/dialog/dialog.js";
import "@home-assistant/webawesome/dist/components/button/button.js";

const INVALID_INPUT = "invalid_input";

@customElement("proxmox-connect-view")
export class ProxmoxConnectView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
    }

    h2 {
      font-size: 1.5rem;
      font-weight: 400;
      color: var(--ha-text-color, #212121);
      margin: 0 0 0.5rem 0;
      text-align: center;
    }

    .subtitle {
      font-size: 1rem;
      color: var(--ha-secondary-text-color, #727272);
      margin: 0 0 1rem 0;
      text-align: center;
    }

    .connect-card {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      padding: 1.5rem;
      background-color: var(--ha-card-background, #ffffff);
      border: 1px solid var(--ha-border-color, #e0e0e0);
      border-radius: 12px;
      width: 100%;
      max-width: 500px;
    }

    @media (prefers-color-scheme: dark) {
      .connect-card {
        background-color: var(--ha-card-background, #1e1e1e);
        border-color: var(--ha-border-color, #333333);
      }
    }

    wa-callout {
      padding: 0;
    }

    wa-dialog {
      --width: 34rem;
    }
    wa-dialog p {
      margin: 0 0 1rem 0;
    }
    .certificate-host {
      overflow-wrap: anywhere;
    }
    .fingerprint-label {
      font-size: 0.8125rem;
      color: var(--ha-secondary-text-color, #727272);
      margin-bottom: 0.25rem;
    }
    .fingerprint {
      font-family: monospace;
      font-size: 0.8125rem;
      line-height: 1.6;
    }

    .status-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 1rem;
      border-radius: 8px;
      background-color: rgba(244, 67, 54, 0.1);
      border: 1px solid rgba(244, 67, 54, 0.3);
    }

    .status-icon {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      background-color: var(--ha-error-fill, #b30532);
    }

    .status-icon svg {
      width: 14px;
      height: 14px;
      fill: white;
    }

    .status-text {
      flex: 1;
    }

    .status-title {
      font-size: 0.9375rem;
      font-weight: 500;
      color: var(--ha-text-color, #212121);
      margin: 0;
    }

    .status-description {
      font-size: 0.8125rem;
      color: var(--ha-error-color, #b30532);
      margin: 0.25rem 0 0 0;
    }
  `;

  @state()
  private _serverUrl = "";

  @state()
  private _username = "root@pam";

  @state()
  private _password = "";

  @state()
  private _totp = "";

  @state()
  private _connecting = false;

  @state()
  private _connected = false;

  @state()
  private _error: InstallerError | null = null;

  @state()
  private _certificate: { url: string; fingerprint: string } | null = null;

  // The certificate the user already trusted for this server, so a second
  // attempt (an authenticator code, a typo in the password) doesn't ask again
  private _trustedCertificate: { url: string; fingerprint: string } | null =
    null;

  private _resolveCertificate?: (confirmed: boolean) => void;
  private _connectionAttempt = 0;

  connectedCallback() {
    super.connectedCallback();

    // Coming back from a later step: show who we're connected as, and keep
    // the session so Next doesn't ask for the password again.
    const { proxmoxSession, proxmoxUsername, proxmoxConnected } =
      wizardState.getState().selections;
    if (proxmoxSession) {
      this._serverUrl = proxmoxSession.server_url;
      this._username = proxmoxUsername ?? this._username;
      this._connected = proxmoxConnected === true;
      if (proxmoxSession.certificate_sha256) {
        this._trustedCertificate = {
          url: proxmoxSession.server_url,
          fingerprint: proxmoxSession.certificate_sha256,
        };
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._connectionAttempt++;
    this._connecting = false;
    this._finishCertificate(false);
  }

  private _finishCertificate(confirmed: boolean) {
    this._resolveCertificate?.(confirmed);
    this._resolveCertificate = undefined;
    this._certificate = null;
  }

  /** Ask the user to trust a certificate their computer does not trust. */
  private async _confirmCertificate(
    url: string,
    fingerprint: string
  ): Promise<boolean> {
    const trusted = this._trustedCertificate;
    if (trusted?.url === url && trusted.fingerprint === fingerprint) {
      return true;
    }

    this._certificate = { url, fingerprint };
    const confirmed = await new Promise<boolean>((resolve) => {
      this._resolveCertificate = resolve;
    });
    if (confirmed) this._trustedCertificate = { url, fingerprint };
    return confirmed;
  }

  /** Connect to Proxmox server. Returns true if successful. */
  async connect(): Promise<boolean> {
    if (this._connected) {
      return true;
    }

    if (this._connecting) return false;
    if (!this._serverUrl || !this._username || !this._password) {
      return this._validationError(
        localize("proxmox.validation.required_fields")
      );
    }

    // Validate URL format - must be HTTPS for security
    const url = this._serverUrl.trim().replace(/\/$/, "");
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        return this._validationError(localize("proxmox.validation.https_url"));
      }
      if (
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      ) {
        return this._validationError(
          localize("views.proxmox.proxmox_connect_view.url_without_extras")
        );
      }
    } catch {
      return this._validationError(localize("proxmox.validation.valid_url"));
    }

    this._connecting = true;
    this._error = null;
    const attempt = ++this._connectionAttempt;
    const flowGeneration = wizardState.flowGeneration;
    const isCurrent = () =>
      this.isConnected &&
      attempt === this._connectionAttempt &&
      flowGeneration === wizardState.flowGeneration;
    const diagnostics = new InstallDiagnostics("proxmox");
    diagnostics.advance("connecting");

    try {
      const fingerprint = await proxmoxCertificateFingerprint(url);
      if (!isCurrent()) return false;
      // No fingerprint means the platform trusts the certificate
      if (fingerprint) {
        const confirmed = await this._confirmCertificate(url, fingerprint);
        if (!confirmed || !isCurrent()) return false;
      }
      const session = await proxmoxConnect({
        server_url: url,
        username: this._username,
        password: this._password,
        totp: this._totp.trim() || undefined,
        ...(fingerprint ? { certificate_sha256: fingerprint } : {}),
      });
      if (!isCurrent()) return false;

      this._connected = true;
      diagnostics.advance("complete");

      // Store session in wizard state
      wizardState.setSelection("proxmoxSession", session);
      wizardState.setSelection("proxmoxUsername", this._username);
      wizardState.setSelection("proxmoxConnected", true);
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      diagnostics.fail(error);
      this._error = installerError(
        error,
        localize("proxmox.connection_failed")
      );
      wizardState.setSelection("proxmoxConnected", false);
      return false;
    } finally {
      if (attempt === this._connectionAttempt) {
        this._totp = "";
        this._connecting = false;
      }
    }
  }

  /** Check if form is valid (all required fields filled) */
  isFormValid(): boolean {
    if (!this._serverUrl || !this._username || !this._password) {
      return false;
    }
    try {
      const url = this._serverUrl.trim();
      const parsed = new URL(url);
      return (
        parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        parsed.pathname === "/" &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  }

  private _onServerUrlChange(e: Event) {
    const input = e.target as WaInput;
    this._serverUrl = input.value ?? "";
    // A trusted certificate belongs to the server it was shown for
    this._trustedCertificate = null;
    this._resetConnection();
  }

  private _onUsernameChange(e: Event) {
    const input = e.target as WaInput;
    this._username = input.value ?? "";
    this._resetConnection();
  }

  private async _validationError(message: string): Promise<false> {
    // A local input problem: no installation help or report link needed
    this._error = {
      code: INVALID_INPUT,
      message,
      retryable: false,
      details: {},
    };
    await this.updateComplete;
    // An identical validation message does not trigger another Lit update.
    if (this.isConnected) {
      this.renderRoot.querySelector<HTMLElement>('[role="alert"]')?.focus();
    }
    return false;
  }

  private _onPasswordChange(e: Event) {
    const input = e.target as WaInput;
    this._password = input.value ?? "";
    this._resetConnection();
  }

  private _onTotpChange(e: Event) {
    this._totp = (e.target as WaInput).value ?? "";
    this._resetConnection();
  }

  private _resetConnection() {
    if (this._connected) {
      this._connected = false;
      wizardState.setSelection("proxmoxConnected", false);
    }
    this._error = null;
  }

  private _onKeyDown(e: KeyboardEvent) {
    // wa-input's own buttons (the password toggle) send their keydown through
    // the host too, and Enter there should reveal the password, not connect.
    // Enter that confirms an input method composition isn't a submit either.
    const fromTextField = e.composedPath()[0] instanceof HTMLInputElement;

    if (
      e.key === "Enter" &&
      fromTextField &&
      !e.isComposing &&
      !this._connecting
    ) {
      // Same path as the Next button, so the app shell's connecting guard
      // applies and a successful login moves on to the next step.
      this.dispatchEvent(
        new CustomEvent("wizard-next", { bubbles: true, composed: true })
      );
    }
  }

  render() {
    return html`
      <h2>
        ${localize("views.proxmox.proxmox_connect_view.connect_to_proxmox_ve")}
      </h2>
      <p class="subtitle">
        ${localize(
          "views.proxmox.proxmox_connect_view.enter_your_proxmox_server_credentials"
        )}
      </p>

      <div class="connect-card">
        ${this._error ? this._renderError() : ""}

        <wa-input
          type="url"
          input-id="server-url"
          label=${localize("views.proxmox.proxmox_connect_view.server_url")}
          hint=${localize("proxmox.server_url_hint")}
          placeholder="https://192.168.1.100:8006"
          autocomplete="url"
          autocapitalize="off"
          autocorrect="off"
          .spellcheck=${false}
          .value=${this._serverUrl}
          @input=${this._onServerUrlChange}
          @keydown=${this._onKeyDown}
          ?disabled=${this._connecting}
        ></wa-input>

        <wa-input
          type="text"
          input-id="username"
          label=${localize("views.proxmox.proxmox_connect_view.username")}
          hint=${localize("proxmox.username_hint")}
          placeholder="root@pam"
          autocomplete="username"
          autocapitalize="off"
          autocorrect="off"
          .spellcheck=${false}
          .value=${this._username}
          @input=${this._onUsernameChange}
          @keydown=${this._onKeyDown}
          ?disabled=${this._connecting}
        ></wa-input>

        <wa-input
          type="password"
          input-id="password"
          label=${localize("views.proxmox.proxmox_connect_view.password")}
          placeholder=${localize(
            "views.proxmox.proxmox_connect_view.enter_your_password"
          )}
          autocomplete="current-password"
          password-toggle
          .value=${this._password}
          @input=${this._onPasswordChange}
          @keydown=${this._onKeyDown}
          ?disabled=${this._connecting}
        ></wa-input>

        <wa-input
          type="text"
          input-id="totp"
          label=${localize(
            "views.proxmox.proxmox_connect_view.authenticator_app_code_optional"
          )}
          autocomplete="one-time-code"
          inputmode="numeric"
          .value=${this._totp}
          @input=${this._onTotpChange}
          @keydown=${this._onKeyDown}
          ?disabled=${this._connecting}
        ></wa-input>
      </div>
      <wa-dialog
        label=${localize(
          "views.proxmox.proxmox_connect_view.trust_server_title"
        )}
        .open=${this._certificate !== null}
        @wa-after-hide=${() => this._finishCertificate(false)}
      >
        <p>
          ${localizeContent(
            "views.proxmox.proxmox_connect_view.untrusted_certificate",
            {
              server: html`<strong class="certificate-host"
                >${this._certificate?.url}</strong
              >`,
            }
          )}
        </p>
        <p>
          ${localize(
            "views.proxmox.proxmox_connect_view.untrusted_certificate_is_normal"
          )}
        </p>
        <p>
          ${localize(
            "views.proxmox.proxmox_connect_view.only_continue_for_your_server"
          )}
        </p>
        <div class="fingerprint-label">
          ${localize(
            "views.proxmox.proxmox_connect_view.certificate_fingerprint"
          )}
        </div>
        <div class="fingerprint">
          ${this._renderFingerprint(this._certificate?.fingerprint ?? "")}
        </div>
        <wa-button
          slot="footer"
          appearance="outlined"
          @click=${() => this._finishCertificate(false)}
          >${localize("common.cancel")}</wa-button
        >
        <wa-button
          slot="footer"
          variant="brand"
          @click=${() => this._finishCertificate(true)}
          >${localize(
            "views.proxmox.proxmox_connect_view.trust_and_connect"
          )}</wa-button
        >
      </wa-dialog>
    `;
  }

  private _renderFingerprint(fingerprint: string) {
    // Wrap between bytes, never inside one
    return fingerprint
      .split(":")
      .map((byte, index) => (index ? html`:<wbr />${byte}` : byte));
  }

  private _renderError() {
    return html`
      <div class="status-row" role="alert">
        <div class="status-icon">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
            />
          </svg>
        </div>
        <div class="status-text">
          <p class="status-title">
            ${localize("views.proxmox.proxmox_connect_view.connection_failed")}
          </p>
          <p class="status-description" style="overflow-wrap: anywhere;">
            ${this._error?.message}
          </p>
          ${this._error?.code === INVALID_INPUT ? "" : renderErrorHelp()}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "proxmox-connect-view": ProxmoxConnectView;
  }
}
