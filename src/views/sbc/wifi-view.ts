import { localize } from "../../localization/localize.js";
import { LitElement, html, css, nothing } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { WizardStateController } from "../../state/wizard-state-controller.js";
import type { WifiConfig } from "../../api/types.js";
import { ssidProblem, wifiPasswordProblem } from "../../utils/wifi.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import type WaSwitch from "@home-assistant/webawesome/dist/components/switch/switch.js";
import "@home-assistant/webawesome/dist/components/input/input.js";
import "@home-assistant/webawesome/dist/components/switch/switch.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";
import { panelStyles } from "../../utils/panel-styles.js";
import { fieldError, fieldErrorStyles } from "../../utils/field-error.js";
import { nextOnEnter } from "../../components/wizard-steps.js";

/** Optional step for boards with built-in Wi-Fi: the network to join. */
@customElement("wifi-view")
export class WifiView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    fieldErrorStyles,
    css`
      .wifi-card {
        ${panelStyles}
      }

      .note {
        max-width: 500px;
        margin: 1rem 0 0 0;
        font-size: 0.875rem;
        line-height: 1.5;
        color: var(--ha-secondary-text-color);
      }
    `,
  ];

  private readonly _wizard = new WizardStateController(this);

  private get _wizardState(): WizardState {
    return this._wizard.state;
  }

  // Fields left at least once. Until then an empty or short value may still
  // be on its way; one filled in on an earlier visit to this step is done.
  @state()
  private _ssidLeft = this._wizardState.selections.wifi !== undefined;

  @state()
  private _passwordLeft = this._wizardState.selections.wifi !== undefined;

  render() {
    const wifi = this._wizardState.selections.wifi;
    const ssidError = wifi && this._ssidError(wifi.ssid);
    const passwordError = wifi && this._passwordError(wifi.password);
    return html`
      ${renderStepHeading(
        localize("views.sbc.wifi_view.title"),
        localize("views.sbc.wifi_view.subtitle")
      )}

      <div class="wifi-card">
        <wa-switch .checked=${wifi !== undefined} @change=${this._onToggle}
          >${localize("views.sbc.wifi_view.connect")}</wa-switch
        >
        ${wifi
          ? html`
              <wa-input
                input-id="wifi-ssid"
                label=${localize("views.sbc.wifi_view.network")}
                autocomplete="off"
                autocapitalize="off"
                autocorrect="off"
                .spellcheck=${false}
                .value=${wifi.ssid}
                @input=${this._onSsidInput}
                @blur=${this._onSsidBlur}
                @keydown=${this._onKeyDown}
                ${fieldError(ssidError)}
              >
                <!-- In the hint slot, so the field describes itself with it.
                  Not role="alert": ViewAccessibility focuses a new alert, which
                  would pull focus out of the field halfway through typing -->
                <span slot="hint" class="ssid-hint" aria-live="polite"
                  >${ssidError ?? ""}</span
                >
              </wa-input>
              <wa-input
                type="password"
                input-id="wifi-password"
                label=${localize("views.sbc.wifi_view.password")}
                autocomplete="off"
                password-toggle
                .value=${wifi.password}
                @input=${this._onPasswordInput}
                @blur=${this._onPasswordBlur}
                @keydown=${this._onKeyDown}
                ${fieldError(passwordError)}
              >
                <!-- In the hint slot and not role="alert", like the network
                  name's -->
                <span slot="hint" class="password-hint" aria-live="polite"
                  >${passwordError ??
                  localize("views.sbc.wifi_view.password_hint")}</span
                >
              </wa-input>
            `
          : nothing}
      </div>
      <p class="note">${localize("views.sbc.wifi_view.supported_networks")}</p>
    `;
  }

  /** Why Next is off because of the network name, once that is clear. */
  private _ssidError(ssid: string): string | undefined {
    switch (ssidProblem(ssid)) {
      case "missing":
        // Not before the step is used, but once a field was left the empty
        // name is what holds Next back
        return this._ssidLeft || this._passwordLeft
          ? localize("views.sbc.wifi_view.network_missing")
          : undefined;
      case "too_long":
        return localize("views.sbc.wifi_view.network_too_long");
      case "control_characters":
        return localize("views.sbc.wifi_view.network_control_characters");
      default:
        return undefined;
    }
  }

  /** Why Next is off because of the password, once that is clear. */
  private _passwordError(password: string): string | undefined {
    switch (wifiPasswordProblem(password)) {
      case "characters":
        return localize("views.sbc.wifi_view.password_characters");
      case "too_long":
        return localize("views.sbc.wifi_view.password_too_long");
      case "too_short":
        // Every password is too short while it's being typed
        return this._passwordLeft
          ? localize("views.sbc.wifi_view.password_too_short")
          : undefined;
      default:
        return undefined;
    }
  }

  private _onToggle(e: Event) {
    // Fresh fields, so nothing to point out until they're used
    this._ssidLeft = false;
    this._passwordLeft = false;
    wizardState.setSelection(
      "wifi",
      (e.target as WaSwitch).checked ? { ssid: "", password: "" } : undefined
    );
  }

  private _onSsidBlur() {
    this._ssidLeft = true;
  }

  private _onPasswordBlur() {
    this._passwordLeft = true;
  }

  private _onKeyDown(e: KeyboardEvent) {
    // Enter says the fields are done, as leaving them does: if Next can't go
    // on yet, their errors say why
    if (nextOnEnter(e)) {
      this._ssidLeft = true;
      this._passwordLeft = true;
    }
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
