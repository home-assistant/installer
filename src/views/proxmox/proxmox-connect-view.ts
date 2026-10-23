import {
  installerError,
  renderErrorHelp,
  type InstallerError,
} from "../../utils/installer-error.js";
import { linkStyles } from "../../utils/link-styles.js";
import { dialogStyles } from "../../utils/dialog-styles.js";
import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { InstallDiagnostics } from "../../utils/diagnostics.js";
import { customElement, queryAll, state } from "lit/decorators.js";
import {
  proxmoxCertificateFingerprint,
  proxmoxConnect,
} from "../../api/commands.js";
import { wizardState } from "../../state/wizard-state.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import "@home-assistant/webawesome/dist/components/input/input.js";
import type WaDialog from "@home-assistant/webawesome/dist/components/dialog/dialog.js";
import "@home-assistant/webawesome/dist/components/dialog/dialog.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import { fieldError, fieldErrorStyles } from "../../utils/field-error.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";

/** The fields Next checks before connecting */
type Field = "serverUrl" | "username" | "password";

/** A certificate belongs to a server, however its address is spelled. */
function serverOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

@customElement("proxmox-connect-view")
export class ProxmoxConnectView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    fieldErrorStyles,
    linkStyles,
    dialogStyles,
    css`
      .connect-card {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
        padding: 1.5rem;
        background-color: var(--ha-card-background, #ffffff);
        border: 1px solid var(--ha-border-color, #e0e0e0);
        border-radius: var(--ha-card-border-radius, 12px);
        width: 100%;
        box-sizing: border-box;
        max-width: 500px;
      }

      /* The address reads left to right in any language, not its label */
      wa-input[type="url"]::part(input) {
        direction: ltr;
      }

      /* The password has no hint, only room for its error */
      wa-input[type="password"]:not([custom-error])::part(hint) {
        margin-block-start: 0;
      }

      wa-dialog p {
        margin: 0 0 1rem 0;
      }
      .certificate-host {
        overflow-wrap: anywhere;
      }
      .certificate-changed {
        color: var(--ha-error-color, #b30532);
        font-weight: 500;
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
        border-radius: var(--ha-small-border-radius, 8px);
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
    `,
  ];

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

  /** What to fix in each field before connecting, until it is edited */
  @state()
  private _fieldErrors: Partial<Record<Field, string>> = {};

  @state()
  private _certificate: {
    url: string;
    fingerprint: string;
    /** The server showed another certificate when it was last trusted */
    changed: boolean;
  } | null = null;

  @queryAll("wa-input")
  private _fields!: NodeListOf<WaInput>;

  // The last certificate trusted for each server, `null` when the platform
  // trusted it. The same one again (an authenticator code, a typo in the
  // password) isn't asked about; a different one is worth a warning.
  private _trustedCertificates = new Map<string, string | null>();

  private _resolveCertificate?: (confirmed: boolean) => void;
  private _connectionAttempt = 0;

  connectedCallback() {
    super.connectedCallback();

    // Coming back from a later step: show who we're connected as, and keep
    // the session so Next doesn't ask for the password again.
    const {
      proxmoxSession,
      proxmoxUsername,
      proxmoxConnected,
      proxmoxPreviousServer,
    } = wizardState.getState().selections;
    if (proxmoxSession) {
      this._serverUrl = proxmoxSession.server_url;
      this._username = proxmoxUsername ?? this._username;
      this._connected = proxmoxConnected === true;
      this._rememberCertificate(
        proxmoxSession.server_url,
        proxmoxSession.certificate_sha256
      );
    } else if (proxmoxPreviousServer) {
      // The session expired or the certificate changed: reconnect to the same
      // server as the same user, and compare the certificate it shows now
      this._serverUrl = proxmoxPreviousServer.server_url;
      this._username = proxmoxUsername ?? this._username;
      this._rememberCertificate(
        proxmoxPreviousServer.server_url,
        proxmoxPreviousServer.certificate_sha256
      );
    }
  }

  private _rememberCertificate(url: string, fingerprint?: string | null) {
    this._trustedCertificates.set(serverOrigin(url), fingerprint ?? null);
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

  private _rejectCertificate() {
    this._finishCertificate(false);
  }

  private _trustCertificate() {
    this._finishCertificate(true);
  }

  private async _onCertificateDialogAfterHide(e: Event) {
    const dialog = e.currentTarget as WaDialog;
    await dialog.updateComplete;
    // Show a question asked while the previous one was closing
    dialog.open = this._certificate !== null;
  }

  /** Ask the user to trust a certificate their computer does not trust. */
  private async _confirmCertificate(
    url: string,
    fingerprint: string
  ): Promise<boolean> {
    const trusted = this._trustedCertificates.get(serverOrigin(url));
    if (trusted === fingerprint) return true;

    this._certificate = { url, fingerprint, changed: trusted !== undefined };
    const confirmed = await new Promise<boolean>((resolve) => {
      this._resolveCertificate = resolve;
    });
    if (confirmed) this._rememberCertificate(url, fingerprint);
    return confirmed;
  }

  /** Connect to Proxmox server. Returns true if successful. */
  async connect(): Promise<boolean> {
    if (this._connected) {
      return true;
    }

    if (this._connecting) return false;
    const url = this._serverUrl.trim().replace(/\/$/, "");
    const fieldErrors = {
      serverUrl: this._serverUrlError(url),
      username: this._username
        ? undefined
        : localize("views.proxmox.proxmox_connect_view.enter_the_username"),
      password: this._password
        ? undefined
        : localize("views.proxmox.proxmox_connect_view.enter_the_password"),
    };
    if (Object.values(fieldErrors).some(Boolean)) {
      return this._showFieldErrors(fieldErrors);
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
      // No fingerprint means the platform trusts the certificate; remembered,
      // so an untrusted one on a retry is a change, not a first visit
      if (fingerprint) {
        const confirmed = await this._confirmCertificate(url, fingerprint);
        if (!confirmed || !isCurrent()) return false;
      } else {
        this._rememberCertificate(url, null);
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

      // A VM made before the session expired lives on the previous server;
      // logged in elsewhere, the install starts over there
      const previous = wizardState.getState().selections.proxmoxPreviousServer;
      if (previous && serverOrigin(previous.server_url) !== serverOrigin(url)) {
        wizardState.setSelection("proxmoxVmResult", undefined);
      }

      // Store session in wizard state
      wizardState.setSelections({
        proxmoxSession: session,
        proxmoxUsername: this._username,
        proxmoxConnected: true,
        proxmoxPreviousServer: undefined,
      });
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

  /** Why the server URL can't be connected to, if it can't */
  private _serverUrlError(url: string): string | undefined {
    if (!url) {
      return localize(
        "views.proxmox.proxmox_connect_view.enter_the_server_url"
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return localize("proxmox.validation.valid_url");
    }
    // Must be HTTPS for security
    if (parsed.protocol !== "https:") {
      return localize("proxmox.validation.https_url");
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return localize("views.proxmox.proxmox_connect_view.url_without_extras");
    }
    return undefined;
  }

  private async _showFieldErrors(
    fieldErrors: Partial<Record<Field, string>>
  ): Promise<false> {
    this._fieldErrors = fieldErrors;
    await this.updateComplete;
    // Each field says what to fix in its hint, which is its description, so
    // go to the first of them rather than to an alert. Every time: Next
    // again with the same errors renders nothing new.
    if (this.isConnected) {
      [...this._fields].find((field) => field.customError)?.focus();
    }
    return false;
  }

  private _onServerUrlChange(e: Event) {
    const input = e.target as WaInput;
    this._serverUrl = input.value ?? "";
    this._resetConnection("serverUrl");
  }

  private _onUsernameChange(e: Event) {
    const input = e.target as WaInput;
    this._username = input.value ?? "";
    this._resetConnection("username");
  }

  private _onPasswordChange(e: Event) {
    const input = e.target as WaInput;
    this._password = input.value ?? "";
    this._resetConnection("password");
  }

  private _onTotpChange(e: Event) {
    this._totp = (e.target as WaInput).value ?? "";
    this._resetConnection();
  }

  private _resetConnection(field?: Field) {
    if (this._connected) {
      this._connected = false;
      wizardState.setSelection("proxmoxConnected", false);
    }
    this._error = null;
    // The edited field's error goes, the others stay until they are fixed
    if (field && this._fieldErrors[field]) {
      this._fieldErrors = { ...this._fieldErrors, [field]: undefined };
    }
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
    // The fields are read-only while connecting, not disabled: that would
    // take the focus from the one Enter was pressed in
    return html`
      ${renderStepHeading(
        localize("views.proxmox.proxmox_connect_view.connect_to_proxmox_ve"),
        localize("views.proxmox.proxmox_connect_view.subtitle")
      )}

      <div class="connect-card">
        ${this._error ? this._renderError() : ""}

        <wa-input
          type="url"
          input-id="server-url"
          label=${localize("views.proxmox.proxmox_connect_view.server_url")}
          placeholder="https://192.168.1.100:8006"
          autocomplete="url"
          autocapitalize="off"
          autocorrect="off"
          .spellcheck=${false}
          required
          .value=${this._serverUrl}
          @input=${this._onServerUrlChange}
          @keydown=${this._onKeyDown}
          ?readonly=${this._connecting}
          ${fieldError(this._fieldErrors.serverUrl)}
        >
          <!-- In the hint slot, so the field describes itself with it. Live:
            Enter in the first field to fix leaves focus where it is, and
            nothing else would read out its new error -->
          <span slot="hint" aria-live="polite"
            >${this._fieldErrors.serverUrl ??
            localize("proxmox.server_url_hint")}</span
          >
        </wa-input>

        <wa-input
          type="text"
          input-id="username"
          label=${localize("views.proxmox.proxmox_connect_view.username")}
          placeholder="root@pam"
          autocomplete="username"
          autocapitalize="off"
          autocorrect="off"
          .spellcheck=${false}
          required
          .value=${this._username}
          @input=${this._onUsernameChange}
          @keydown=${this._onKeyDown}
          ?readonly=${this._connecting}
          ${fieldError(this._fieldErrors.username)}
        >
          <span slot="hint" aria-live="polite"
            >${this._fieldErrors.username ??
            localize("proxmox.username_hint")}</span
          >
        </wa-input>

        <wa-input
          type="password"
          input-id="password"
          label=${localize("views.proxmox.proxmox_connect_view.password")}
          autocomplete="current-password"
          password-toggle
          required
          .value=${this._password}
          @input=${this._onPasswordChange}
          @keydown=${this._onKeyDown}
          ?readonly=${this._connecting}
          ${fieldError(this._fieldErrors.password)}
        >
          <span slot="hint" aria-live="polite"
            >${this._fieldErrors.password ?? ""}</span
          >
        </wa-input>

        <wa-input
          type="text"
          input-id="totp"
          label=${localize(
            "views.proxmox.proxmox_connect_view.authenticator_app_code_optional"
          )}
          autocomplete="one-time-code"
          inputmode="numeric"
          hint=${localize("views.proxmox.proxmox_connect_view.totp_hint")}
          .value=${this._totp}
          @input=${this._onTotpChange}
          @keydown=${this._onKeyDown}
          ?readonly=${this._connecting}
        ></wa-input>
      </div>
      <wa-dialog
        label=${localize(
          "views.proxmox.proxmox_connect_view.trust_server_title"
        )}
        .open=${this._certificate !== null}
        @wa-hide=${this._rejectCertificate}
        @wa-after-hide=${this._onCertificateDialogAfterHide}
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
        ${this._certificate?.changed
          ? html`<p class="certificate-changed">
              ${localize(
                "views.proxmox.proxmox_connect_view.certificate_changed"
              )}
            </p>`
          : html`<p>
              ${localize(
                "views.proxmox.proxmox_connect_view.untrusted_certificate_is_normal"
              )}
            </p>`}
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
          <bdi
            >${this._renderFingerprint(
              this._certificate?.fingerprint ?? ""
            )}</bdi
          >
        </div>
        <wa-button
          slot="footer"
          appearance="outlined"
          @click=${this._rejectCertificate}
          >${localize("common.cancel")}</wa-button
        >
        <wa-button
          slot="footer"
          variant="brand"
          @click=${this._trustCertificate}
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
          ${renderErrorHelp()}
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
