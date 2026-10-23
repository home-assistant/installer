import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { formatNumber, localize } from "../localization/localize.js";
import {
  installerUpdate,
  type InstallerUpdateState,
} from "../state/installer-update.js";
import { openExternalLink, openExternalUrl } from "../utils/external-url.js";
import { linkStyles } from "../utils/link-styles.js";
import "@home-assistant/webawesome/dist/components/button/button.js";

/**
 * Offers a newer version of the installer, and installs it. It only sits on
 * the welcome screen, and the app only restarts into the update while it
 * shows, so no installation and nothing entered in a flow is cut short.
 */
@customElement("update-banner")
export class UpdateBanner extends LitElement {
  static styles = [
    linkStyles,
    css`
      :host {
        display: block;
        width: 100%;
        max-width: 640px;
      }

      :host([hidden]) {
        display: none;
      }

      .banner {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem 1rem;
        padding: 0.75rem 1rem;
        border: 1px solid var(--ha-border-color, #e0e0e0);
        border-radius: var(--ha-small-border-radius, 8px);
        background-color: var(--ha-card-background, #ffffff);
        color: var(--ha-text-color, #212121);
        font-size: 0.875rem;
        line-height: 1.5;
        text-align: left;
      }

      .message {
        margin: 0;
        flex: 1 1 16rem;
        overflow-wrap: anywhere;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
      }

      /* Busy, the button still says what it does, beside the spinner */
      wa-button[loading]::part(label) {
        opacity: 1;
      }

      wa-button[loading]::part(spinner) {
        position: static;
        order: -1;
        margin-inline-end: 0.5em;
      }
    `,
  ];

  @state()
  private _state: InstallerUpdateState = installerUpdate.state;

  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = installerUpdate.subscribe((state) => {
      this._state = state;
    });
    installerUpdate.setVisible(true);
    this._state = installerUpdate.state;
    void installerUpdate.check();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    installerUpdate.setVisible(false);
  }

  protected willUpdate() {
    this.hidden = this._state.status === "none";
  }

  render() {
    const state = this._state;
    if (state.status === "none") return nothing;
    const { status, update } = state;
    const busy =
      status === "downloading" ||
      status === "installing" ||
      status === "restarting";
    const failed = status === "failed";
    const canInstall = update.installable && (!failed || state.error.retryable);
    // One install button throughout, so it keeps the focus while it's busy
    return html`<div class="banner">
      <p class="message">
        <span role="status">${this._message(state)}</span>
        ${this._renderPercent(state)}
        ${status === "available"
          ? html`<a
              class="notes"
              href=${update.release_url}
              @click=${openExternalLink}
              >${localize("components.update_banner.whats_new")}</a
            >`
          : nothing}
      </p>
      <div class="actions">
        ${canInstall
          ? html`<wa-button
              class="install"
              size="s"
              variant="brand"
              ?loading=${busy}
              @click=${status === "ready" ? this._onRestart : this._onUpdate}
            >
              ${failed
                ? localize("common.try_again")
                : status === "ready"
                  ? localize("components.update_banner.restart_now")
                  : localize("components.update_banner.update")}
            </wa-button>`
          : nothing}
        ${failed || !update.installable
          ? html`<wa-button
              class="download"
              size="s"
              appearance=${canInstall ? "outlined" : "accent"}
              variant=${canInstall ? "neutral" : "brand"}
              @click=${this._onDownload}
            >
              ${localize("components.update_banner.download")}
            </wa-button>`
          : nothing}
        ${busy
          ? nothing
          : html`<wa-button
              class="dismiss"
              size="s"
              appearance="plain"
              @click=${this._onDismiss}
            >
              ${localize("components.update_banner.not_now")}
            </wa-button>`}
      </div>
    </div>`;
  }

  /** What changes, and so what screen readers announce: never the percentage. */
  private _message(state: Exclude<InstallerUpdateState, { status: "none" }>) {
    switch (state.status) {
      case "available":
        return state.update.installable
          ? localize("components.update_banner.available", {
              version: state.update.version,
            })
          : localize("components.update_banner.available_move_first", {
              version: state.update.version,
            });
      case "downloading":
        return localize("components.update_banner.downloading");
      case "installing":
        return localize("components.update_banner.installing");
      case "restarting":
        return localize("components.update_banner.restarting");
      case "ready":
        return state.blocked
          ? localize("components.update_banner.restart_after_installation")
          : localize("components.update_banner.ready");
      case "failed":
        return localize("components.update_banner.failed");
    }
  }

  /** The download's progress, outside the announced status. */
  private _renderPercent(state: InstallerUpdateState) {
    if (state.status !== "downloading" || !state.progress?.total)
      return nothing;
    const { downloaded, total } = state.progress;
    return html`<span class="percent"
      >${formatNumber(Math.min(downloaded / total, 1), {
        style: "percent",
      })}</span
    >`;
  }

  private _onUpdate() {
    void installerUpdate.update();
  }

  private _onRestart() {
    void installerUpdate.restart();
  }

  private _onDownload() {
    const state = this._state;
    if (state.status !== "none") void openExternalUrl(state.update.release_url);
  }

  private _onDismiss() {
    installerUpdate.dismiss();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "update-banner": UpdateBanner;
  }
}
