import { localize, localizeContent } from "../../localization/localize.js";
import {
  installerError,
  renderErrorHelp,
  type InstallerError,
} from "../../utils/installer-error.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { InstallDiagnostics } from "../../utils/diagnostics.js";
import { customElement, state } from "lit/decorators.js";
import { checkUtmStatus } from "../../api/commands.js";
import type { UtmStatus } from "../../api/types.js";
import { wizardState } from "../../state/wizard-state.js";
import { openExternalUrl } from "../../utils/external-url.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "../../components/ha-svg-icon.js";
import "../../components/casita-mascot.js";

// mdi:download
const mdiDownload = "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z";
// mdi:refresh
const mdiRefresh =
  "M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z";

@customElement("utm-check-view")
export class UtmCheckView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = css`
    ${reducedMotionStyles}
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

    .status-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
      padding: 1.25rem;
      background-color: var(--ha-card-background, #ffffff);
      border: 1px solid var(--ha-border-color, #e0e0e0);
      border-radius: 12px;
      width: 100%;
      max-width: 500px;
    }

    @media (prefers-color-scheme: dark) {
      .status-card {
        background-color: var(--ha-card-background, #1e1e1e);
        border-color: var(--ha-border-color, #333333);
      }
    }

    casita-mascot {
      width: 96px;
      height: 96px;
    }

    .status-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .status-icon {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .status-icon.loading {
      width: 24px;
      height: 24px;
      background: none;
    }

    .status-icon.success {
      background-color: #4caf50;
    }

    .status-icon.warning {
      background-color: #ff9800;
    }

    .status-icon svg {
      width: 16px;
      height: 16px;
      fill: white;
    }

    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid var(--ha-secondary-text-color, #727272);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .status-text {
      display: flex;
      flex-direction: column;
    }

    .status-title {
      font-size: 1rem;
      font-weight: 500;
      color: var(--ha-text-color, #212121);
      margin: 0;
    }

    .status-description {
      font-size: 0.8125rem;
      color: var(--ha-secondary-text-color, #727272);
      margin: 0.25rem 0 0 0;
    }

    .version-info {
      font-size: 0.75rem;
      color: var(--ha-secondary-text-color, #9e9e9e);
      margin: 0;
    }

    .warning-card {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 1rem 1.25rem;
      background-color: rgba(255, 152, 0, 0.1);
      border: 1px solid rgba(255, 152, 0, 0.3);
      border-radius: 12px;
      width: 100%;
      max-width: 500px;
      margin-bottom: 1rem;
    }

    @media (prefers-color-scheme: dark) {
      .warning-card {
        background-color: rgba(255, 152, 0, 0.15);
        border-color: rgba(255, 152, 0, 0.4);
      }
    }

    .warning-title {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--ha-text-color, #212121);
      margin: 0;
    }

    @media (prefers-color-scheme: dark) {
      .warning-title {
        color: #ffb74d;
      }
    }

    .warning-description {
      font-size: 0.8125rem;
      color: var(--ha-text-color, #212121);
      margin: 0;
    }

    .warning-list {
      list-style: none;
      padding: 0;
      margin: 0;
      font-size: 0.8125rem;
      color: var(--ha-text-color, #212121);
    }

    .warning-list li {
      padding-left: 1rem;
      position: relative;
      line-height: 1.4;
    }

    .warning-list li::before {
      content: "•";
      position: absolute;
      left: 0;
      color: #ff9800;
    }

    wa-button ha-svg-icon {
      --mdc-icon-size: 1.2em;
    }
  `;

  @state()
  private _loading = true;

  @state()
  private _utmStatus: UtmStatus | null = null;

  @state()
  private _error: InstallerError | null = null;

  connectedCallback() {
    super.connectedCallback();
    void this._checkStatus();
  }

  private async _checkStatus() {
    this._loading = true;
    this._error = null;

    try {
      const status = await checkUtmStatus();
      this._utmStatus = status;

      // Store UTM installed status in wizard state
      wizardState.setSelection("utmInstalled", status.installed);
    } catch (error) {
      if (this.isConnected) new InstallDiagnostics("utm").fail(error);
      this._error = installerError(
        error,
        localize("views.utm.utm_check_view.failed_to_check_utm_status")
      );
      wizardState.setSelection("utmInstalled", false);
    } finally {
      this._loading = false;
    }
  }

  render() {
    return html`
      <h2>${localize("views.utm.utm_check_view.virtual_machine_setup")}</h2>
      <p class="subtitle">
        ${localize(
          "views.utm.utm_check_view.run_home_assistant_in_a_virtual_machine_using_utm"
        )}
      </p>

      <div class="warning-card">
        <p class="warning-title">
          ${localize("views.utm.utm_check_view.best_for_testing_evaluation")}
        </p>
        <p class="warning-description">
          ${localize(
            "views.utm.utm_check_view.a_virtual_machine_in_utm_is_great_for_trying_home_assistant_out_but_maybe_n"
          )}
        </p>
        <ul class="warning-list">
          <li>
            ${localize(
              "views.utm.utm_check_view.your_mac_needs_to_be_running_and_you_need_to_be_logged_in"
            )}
          </li>
          <li>
            ${localize(
              "views.utm.utm_check_view.the_virtual_machine_won_t_start_automatically_on_boot"
            )}
          </li>
          <li>
            ${localize(
              "views.utm.utm_check_view.for_always_on_home_assistant_dedicated_hardware_is_recommended"
            )}
          </li>
        </ul>
      </div>

      <div class="status-card">
        <casita-mascot
          mood=${this._loading
            ? "loading"
            : this._error
              ? "problem"
              : this._utmStatus?.installed
                ? "happy"
                : "sad"}
        ></casita-mascot>
        ${this._loading
          ? this._renderLoading()
          : this._error
            ? this._renderError()
            : this._utmStatus?.installed
              ? this._renderInstalled()
              : this._renderNotInstalled()}
      </div>
    `;
  }

  private _renderLoading() {
    return html`
      <div class="status-row">
        <div class="status-icon loading">
          <div class="spinner"></div>
        </div>
        <div class="status-text">
          <p class="status-title">
            ${localize("views.utm.utm_check_view.checking_for_utm")}
          </p>
        </div>
      </div>
    `;
  }

  private _renderError() {
    return html`
      <div class="status-row" role="alert">
        <div class="status-icon warning">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"
            />
          </svg>
        </div>
        <div class="status-text">
          <p class="status-title">
            ${localize("views.utm.utm_check_view.error_checking_utm")}
          </p>
          <p class="status-description" style="overflow-wrap: anywhere;">
            ${this._error?.message}
          </p>
          ${renderErrorHelp()}
        </div>
      </div>
      ${this._error?.retryable
        ? html`<wa-button
            variant="brand"
            appearance="outlined"
            @click=${this._checkStatus}
          >
            ${localizeContent("views.utm.utm_check_view.value_try_again", {
              value0: this._renderRefreshIcon(),
            })}
          </wa-button>`
        : ""}
    `;
  }

  private _renderInstalled() {
    return html`
      <div class="status-row">
        <div class="status-icon success">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
          </svg>
        </div>
        <div class="status-text">
          <p class="status-title">
            ${this._utmStatus?.version
              ? localizeContent("utm.installed_with_version", {
                  version: html`<span class="version-info"
                    >${localize("utm.version", {
                      version: this._utmStatus.version,
                    })}</span
                  >`,
                })
              : localize("utm.installed")}
          </p>
          <p class="status-description">
            ${localize(
              "views.utm.utm_check_view.ready_to_create_a_home_assistant_virtual_machine"
            )}
          </p>
        </div>
      </div>
    `;
  }

  private _renderNotInstalled() {
    return html`
      <div class="status-row">
        <div class="status-icon warning">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"
            />
          </svg>
        </div>
        <div class="status-text">
          <p class="status-title">
            ${localize("views.utm.utm_check_view.utm_is_not_installed")}
          </p>
          <p class="status-description">
            ${localize(
              "views.utm.utm_check_view.download_and_install_utm_to_continue_utm_is_a_free_open_source_virtualizati"
            )}
          </p>
        </div>
      </div>
      <wa-button
        variant="brand"
        appearance="accent"
        @click=${this._openUtmDownload}
      >
        ${localizeContent("views.utm.utm_check_view.value_download_utm", {
          value0: this._renderDownloadIcon(),
        })}
      </wa-button>
      <wa-button
        variant="brand"
        appearance="outlined"
        @click=${this._checkStatus}
      >
        ${localizeContent("views.utm.utm_check_view.value_i_ve_installed_utm", {
          value0: this._renderRefreshIcon(),
        })}
      </wa-button>
    `;
  }

  private _renderDownloadIcon() {
    return html`<ha-svg-icon slot="start" .path=${mdiDownload}></ha-svg-icon>`;
  }

  private _renderRefreshIcon() {
    return html`<ha-svg-icon slot="start" .path=${mdiRefresh}></ha-svg-icon>`;
  }

  private async _openUtmDownload() {
    await openExternalUrl("https://mac.getutm.app/");
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "utm-check-view": UtmCheckView;
  }
}
