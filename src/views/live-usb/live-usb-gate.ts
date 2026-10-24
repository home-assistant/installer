import { localize } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import {
  ViewAccessibility,
  activeElement,
} from "../../utils/view-accessibility.js";
import {
  installerError,
  type InstallerError,
} from "../../utils/installer-error.js";
import { getLiveUsbStatus, type LiveUsbStatus } from "../../api/index.js";
import { wizardState } from "../../state/wizard-state.js";
import { LatestRequest } from "../../utils/latest-request.js";
import { renderRetryButton } from "../../utils/load-state.js";
import { liveUsbStyles } from "./live-usb-styles.js";

/**
 * Shows its content only once the live USB flow can run: the program for the
 * stick (hai-live) is there. Sets the `liveReady` selection so the shell
 * keeps Next disabled until then. Administrator rights, which writing a stick
 * needs on Windows, are the drive step's to ask for.
 */
@customElement("live-usb-gate")
export class LiveUsbGate extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    liveUsbStyles,
    css`
      :host {
        width: 100%;
      }
      ::slotted(drive-selection-view) {
        align-self: stretch;
      }
    `,
  ];

  @state()
  private _status: LiveUsbStatus | null = null;

  @state()
  private _error: InstallerError | null = null;

  @state()
  private _checking = false;

  private readonly _checks = new LatestRequest(this);

  @query("slot")
  private _slot?: HTMLSlotElement;

  private _initialFocus: Element | null = null;
  private _contentFocused = false;

  connectedCallback() {
    super.connectedCallback();
    this._initialFocus = activeElement();
    this._contentFocused = false;
    void this._check();
  }

  private get _ready(): boolean {
    return !this._error && !!this._status?.hai_live_found;
  }

  updated() {
    if (this._contentFocused || !this._ready) return;
    this._contentFocused = true;
    // The content's own heading focus ran while it was still hidden
    const active = activeElement();
    if (active !== this._initialFocus && active !== document.body) return;
    const slot = this._slot;
    for (const element of slot?.assignedElements() ?? []) {
      const heading = element.matches("h1, h2")
        ? element
        : (element.shadowRoot?.querySelector("h1, h2") ??
          element.querySelector("h1, h2"));
      if (heading instanceof HTMLElement) {
        heading.tabIndex = -1;
        heading.focus();
        return;
      }
    }
  }

  private async _check() {
    const check = this._checks.start();
    // The previous result, and its Try again, stay until this one replaces it,
    // so focus stays where it was
    this._checking = true;
    wizardState.setSelection("liveReady", false);
    try {
      const status = await getLiveUsbStatus();
      if (!check.current) return;
      this._error = null;
      this._status = status;
      wizardState.setSelection("liveReady", status.hai_live_found);
    } catch (error) {
      if (!check.current) return;
      this._error = installerError(error);
    } finally {
      if (check.current) this._checking = false;
    }
  }

  render() {
    if (this._error) {
      // Empty while checking, like renderLoadError(): the same failure coming
      // back is then new text, and read out again
      return html`
        <div class="notice error">
          <p data-focus-alert>${this._checking ? "" : this._error.message}</p>
          ${renderRetryButton(this._checking, () => this._check())}
        </div>
      `;
    }
    if (!this._status) {
      return html`<p class="subtitle">${localize("common.loading")}</p>`;
    }
    if (!this._status.hai_live_found) {
      return html`
        <h2>
          ${localize("views.live_usb.live_usb_gate.hai_live_missing_title")}
        </h2>
        <div class="notice error" data-focus-alert>
          <p>${localize("views.live_usb.live_usb_gate.hai_live_missing")}</p>
          <p>
            <code
              >cargo build --release -p hai-live --target
              x86_64-unknown-linux-musl</code
            >
          </p>
          <p>
            ${localize("views.live_usb.live_usb_gate.hai_live_missing_env")}
          </p>
        </div>
      `;
    }
    return html`<slot></slot>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "live-usb-gate": LiveUsbGate;
  }
}
