import { localize, localizeContent } from "../../localization/localize.js";
import {
  installerError,
  type InstallerError,
} from "../../utils/installer-error.js";
import { linkStyles } from "../../utils/link-styles.js";
import { LitElement, html, css, nothing } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { recordFailure } from "../../utils/diagnostics.js";
import { customElement, query, state } from "lit/decorators.js";
import { checkUtmAutomation, checkUtmStatus } from "../../api/commands.js";
import type { UtmStatus } from "../../api/types.js";
import { wizardState } from "../../state/wizard-state.js";
import { openExternalUrl } from "../../utils/external-url.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "../../components/ha-svg-icon.js";
import "../../components/casita-mascot.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";
import {
  renderRetryButton,
  renderStatusRow,
  statusRowStyles,
} from "../../utils/load-state.js";

// mdi:download
const mdiDownload = "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z";
// mdi:refresh
const mdiRefresh =
  "M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z";

@customElement("utm-check-view")
export class UtmCheckView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    statusRowStyles,
    linkStyles,
    css`
      .status-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
        padding: 1.25rem;
        background-color: var(--ha-card-background, #ffffff);
        border: 1px solid var(--ha-border-color, #e0e0e0);
        border-radius: var(--ha-card-border-radius, 12px);
        width: 100%;
        box-sizing: border-box;
        max-width: 500px;
      }

      casita-mascot {
        width: 96px;
        height: 96px;
      }

      /* Out of the card's flow while empty, so it adds no gap, yet still in
         the accessibility tree to announce what comes next */
      .status.empty {
        position: absolute;
      }

      .status-text.unavailable {
        text-align: center;
      }

      .version-info {
        font-size: 0.75rem;
        color: var(--ha-secondary-text-color, #9e9e9e);
        margin: 0;
      }

      .testing-note {
        max-width: 500px;
        margin: 0 0 1.5rem;
        font-size: 0.875rem;
        line-height: 1.5;
        color: var(--ha-secondary-text-color, #727272);
        text-align: center;
      }

      wa-button ha-svg-icon {
        --mdc-icon-size: 1.2em;
      }
    `,
  ];

  @state()
  private _loading = true;

  @state()
  private _utmStatus: UtmStatus | null = null;

  @state()
  private _error: InstallerError | null = null;

  /** UTM is installed, and macOS may be asking whether the installer can control it */
  @state()
  private _askingAutomation = false;

  @query(".status .status-title")
  private _statusTitle?: HTMLElement;

  /** Bumped per check, so only the latest one decides */
  private _check = 0;

  connectedCallback() {
    super.connectedCallback();
    void this._checkStatus();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._check++;
  }

  private async _checkStatus() {
    const check = ++this._check;
    const flowGeneration = wizardState.flowGeneration;
    // The Automation prompt can stay open while the user leaves the step;
    // its answer then belongs to no flow
    const isCurrent = () =>
      this.isConnected &&
      check === this._check &&
      flowGeneration === wizardState.flowGeneration;
    // The previous result, and its buttons, stay until this one replaces it
    this._loading = true;
    // Coming back from a later step left this set: Next waits for the check
    wizardState.setSelection("utmInstalled", false);

    // Shown only once the check is done, Automation included: the macOS
    // prompt can take a while, and the buttons of the result being checked
    // again stay meanwhile
    let status: UtmStatus | undefined;
    try {
      status = await checkUtmStatus();
      if (!isCurrent()) return;

      // Ask for Automation now, not after the download: a refusal then
      // costs nothing, and an unnoticed prompt can't stall the install
      if (status.installed) {
        this._askingAutomation = true;
        await checkUtmAutomation();
        if (!isCurrent()) return;
      }

      // Store UTM installed status in wizard state
      this._utmStatus = status;
      this._error = null;
      wizardState.setSelection("utmInstalled", status.installed);
    } catch (error) {
      if (!isCurrent()) return;
      if (status) this._utmStatus = status;
      recordFailure("utm", error);
      this._error = installerError(
        error,
        localize("views.utm.utm_check_view.failed_to_check_utm_status")
      );
      wizardState.setSelection("utmInstalled", false);
    } finally {
      if (check === this._check) {
        this._loading = false;
        this._askingAutomation = false;
      }
    }

    // The button that started the check can be gone now, as when UTM was
    // found: continue from what the check found
    await this.updateComplete;
    if (!isCurrent()) return;
    this._accessibility.restoreFocus(this._statusTitle);
  }

  /** An Intel Mac: nothing to fix or retry, this option just isn't for it. */
  private get _unavailable() {
    return this._error?.code === "unsupported_platform";
  }

  render() {
    const status = this._renderStatus();
    return html`
      ${renderStepHeading(
        localize("views.utm.utm_check_view.virtual_machine_setup"),
        localize("views.utm.utm_check_view.subtitle")
      )}
      ${this._unavailable ? "" : this._renderTestingNote()}

      <div class="status-card">
        <casita-mascot
          mood=${this._loading
            ? "loading"
            : this._unavailable
              ? "sad"
              : this._error
                ? "problem"
                : this._utmStatus?.installed
                  ? "happy"
                  : "sad"}
        ></casita-mascot>
        <!-- Stays in the DOM, so each new status is announced -->
        <div
          class=${status === nothing ? "status empty" : "status"}
          role="status"
        >
          ${status}
        </div>
        ${this._error && !this._loading && !this._unavailable
          ? this._renderError()
          : ""}
        ${this._renderActions()}
      </div>
    `;
  }

  private _renderStatus() {
    if (this._loading) return this._renderLoading();
    if (this._unavailable) return this._renderUnavailable();
    // The alert says what went wrong
    if (this._error) return nothing;
    return this._utmStatus?.installed
      ? this._renderInstalled()
      : this._renderNotInstalled();
  }

  /**
   * What the result offers to do. A check started here keeps them, busy, so
   * the button pressed keeps focus while it runs.
   */
  private _renderActions() {
    if (this._unavailable) return "";
    if (this._error) {
      return this._error.retryable
        ? renderRetryButton(this._loading, () => this._checkStatus())
        : "";
    }
    if (!this._utmStatus || this._utmStatus.installed) return "";
    return html`
      <wa-button
        variant="brand"
        appearance="accent"
        @click=${this._openUtmDownload}
      >
        ${this._renderDownloadIcon()}
        ${localize("views.utm.utm_check_view.download_utm")}
      </wa-button>
      <wa-button
        variant="brand"
        appearance="outlined"
        ?loading=${this._loading}
        @click=${this._checkStatus}
      >
        ${this._renderRefreshIcon()}
        ${localize("views.utm.utm_check_view.confirm_installed")}
      </wa-button>
    `;
  }

  private _renderTestingNote() {
    return html`<p class="testing-note">
      ${localize("views.utm.utm_check_view.testing_note")}
    </p>`;
  }

  private _renderUnavailable() {
    return html`
      <div class="status-text unavailable">
        <p class="status-title">
          ${localize("views.utm.utm_check_view.not_available_on_this_mac")}
        </p>
        <p class="status-description">
          ${localize(
            "views.utm.utm_check_view.utm_installs_need_apple_silicon"
          )}
        </p>
      </div>
    `;
  }

  private _renderLoading() {
    return this._askingAutomation
      ? renderStatusRow(
          "loading",
          localize("views.utm.utm_check_view.allow_control_of_utm"),
          localize("views.utm.utm_check_view.allow_control_of_utm_description")
        )
      : renderStatusRow(
          "loading",
          localize("views.utm.utm_check_view.checking_for_utm")
        );
  }

  private _renderError() {
    return renderStatusRow(
      "error",
      localize("views.utm.utm_check_view.error_checking_utm"),
      this._error?.message
    );
  }

  private _renderInstalled() {
    return renderStatusRow(
      "success",
      this._utmStatus?.version
        ? localizeContent("utm.installed_with_version", {
            version: html`<span class="version-info"
              >${localize("utm.version", {
                version: this._utmStatus.version,
              })}</span
            >`,
          })
        : localize("utm.installed"),
      localize("views.utm.utm_check_view.ready")
    );
  }

  private _renderNotInstalled() {
    return renderStatusRow(
      "warning",
      localize("views.utm.utm_check_view.utm_is_not_installed"),
      localize("views.utm.utm_check_view.not_installed_description")
    );
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
