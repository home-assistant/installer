import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { formatNumber, localize } from "../localization/localize.js";
import {
  installerUpdate,
  type InstallerUpdateState,
} from "../state/installer-update.js";
import { openExternalUrl } from "../utils/external-url.js";
import { renderExternalLink } from "../utils/external-link.js";
import { linkStyles } from "../utils/link-styles.js";
import { LiveStatus, srOnlyStyles } from "../utils/view-accessibility.js";
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
    srOnlyStyles,
    css`
      /* With nothing to offer, only the empty live region, which takes no
         room: hidden, it wouldn't announce the offer once it comes */
      :host {
        display: block;
        width: 100%;
        max-width: 640px;
      }

      .banner {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem 1rem;
        padding: 0.75rem 1rem;
        border: 1px solid var(--ha-border-color);
        border-radius: var(--ha-small-border-radius);
        background-color: var(--ha-card-background);
        color: var(--ha-text-color);
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

  private readonly _status = new LiveStatus(this);

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

  render() {
    const state = this._state;
    const message = state.status === "none" ? "" : this._message(state);
    // Mounted empty first, even with nothing to offer, and kept as the same
    // element, so screen readers announce the offer, and the ready update
    // when the user is back
    return html`<p class="sr-only" role="status" aria-atomic="true">
        ${this._status.ready ? message : ""}
      </p>
      ${state.status === "none" ? nothing : this._renderBanner(state, message)}`;
  }

  private _renderBanner(
    state: Exclude<InstallerUpdateState, { status: "none" }>,
    message: string
  ) {
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
        <span class="text" aria-hidden="true">${message}</span>
        ${this._renderPercent(state)}
        ${status === "available"
          ? renderExternalLink(
              update.release_url,
              localize("components.update_banner.whats_new"),
              { className: "notes" }
            )
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
        ${busy || installerUpdate.restartRequested
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
