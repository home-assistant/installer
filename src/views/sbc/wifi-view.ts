import { localize } from "../../localization/localize.js";
import { LitElement, html, css, nothing } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import type { WifiConfig } from "../../api/types.js";
import { ssidTooLong } from "../../utils/wifi.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import type WaSwitch from "@home-assistant/webawesome/dist/components/switch/switch.js";
import "@home-assistant/webawesome/dist/components/input/input.js";
import "@home-assistant/webawesome/dist/components/switch/switch.js";

/** Optional step for boards with built-in Wi-Fi: the network to join. */
@customElement("wifi-view")
export class WifiView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100%;
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
      margin: 0 0 1.5rem 0;
      text-align: center;
      max-width: 500px;
    }

    .wifi-card {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding: 1.5rem;
      background-color: var(--ha-card-background, #ffffff);
      border: 1px solid var(--ha-border-color, #e0e0e0);
      border-radius: 12px;
      width: 100%;
      box-sizing: border-box;
      max-width: 500px;
    }

    @media (prefers-color-scheme: dark) {
      .wifi-card {
        background-color: var(--ha-card-background, #1e1e1e);
        border-color: var(--ha-border-color, #333333);
      }
    }

    .note {
      max-width: 500px;
      margin: 1rem 0 0 0;
      font-size: 0.875rem;
      line-height: 1.5;
      color: var(--ha-secondary-text-color, #727272);
    }
  `;

  @state()
  private _wizardState: WizardState = wizardState.getState();

  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = wizardState.subscribe((state) => {
      this._wizardState = state;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  render() {
    const wifi = this._wizardState.selections.wifi;
    return html`
      <h2>${localize("views.sbc.wifi_view.title")}</h2>
      <p class="subtitle">${localize("views.sbc.wifi_view.subtitle")}</p>

      <div class="wifi-card">
        <wa-switch .checked=${wifi !== undefined} @change=${this._onToggle}
          >${localize("views.sbc.wifi_view.connect")}</wa-switch
        >
        ${wifi
          ? html`
              <wa-input
                input-id="wifi-ssid"
                label=${localize("views.sbc.wifi_view.network")}
                hint=${ssidTooLong(wifi.ssid)
                  ? localize("views.sbc.wifi_view.network_too_long")
                  : ""}
                autocomplete="off"
                autocapitalize="off"
                autocorrect="off"
                .spellcheck=${false}
                .value=${wifi.ssid}
                @input=${this._onSsidInput}
              ></wa-input>
              <wa-input
                type="password"
                input-id="wifi-password"
                label=${localize("views.sbc.wifi_view.password")}
                hint=${localize("views.sbc.wifi_view.password_hint")}
                autocomplete="off"
                password-toggle
                .value=${wifi.password}
                @input=${this._onPasswordInput}
              ></wa-input>
            `
          : nothing}
      </div>
      <p class="note">${localize("views.sbc.wifi_view.supported_networks")}</p>
    `;
  }

  private _onToggle(e: Event) {
    wizardState.setSelection(
      "wifi",
      (e.target as WaSwitch).checked ? { ssid: "", password: "" } : undefined
    );
  }

  private _onSsidInput(e: Event) {
    this._update({ ssid: (e.target as WaInput).value ?? "" });
  }

  private _onPasswordInput(e: Event) {
    this._update({ password: (e.target as WaInput).value ?? "" });
  }

  private _update(change: Partial<WifiConfig>) {
    const wifi = this._wizardState.selections.wifi;
    if (wifi) wizardState.setSelection("wifi", { ...wifi, ...change });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "wifi-view": WifiView;
  }
}
