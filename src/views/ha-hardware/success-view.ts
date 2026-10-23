import { localize } from "../../localization/localize.js";
import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { openExternalLink } from "../../utils/external-url.js";
import { selectedWifi } from "../../utils/wifi.js";
import { renderOpenHomeAssistantStep } from "../sbc/success-view.js";
import {
  findHaHardware,
  haHardwareName,
  type HaHardwareId,
} from "./hardware.js";

import "../../components/install-success.js";

const GUIDES: Record<HaHardwareId, string> = {
  green: "https://support.nabucasa.com/hc/en-us/articles/25162566451485",
  "yellow-cm4": "https://support.nabucasa.com/hc/en-us/articles/25484982657309",
  "yellow-cm5": "https://support.nabucasa.com/hc/en-us/articles/25485061432093",
  blue: "https://www.home-assistant.io/installation/odroid",
};

@customElement("ha-hardware-success-view")
export class HaHardwareSuccessView extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100%;
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
    const hardware = this._wizardState.selections.haHardware;
    // The device and module steps always pick one before the flow gets here.
    // Without it, no device's steps apply, so show the ones that fit any board
    // instead of guessing one, even if the name or board of one was left behind.
    if (!hardware) return html`<success-view generic></success-view>`;
    const guide = GUIDES[hardware];
    // Without an installer, Home Assistant OS itself is on the drive and
    // starts its first setup when the device boots from it
    const writesHaos = !findHaHardware(hardware)?.installer;

    return html`
      <install-success
        .subtitle=${writesHaos
          ? localize("common.success.subtitle")
          : localize("views.ha_hardware.success_view.subtitle")}
        .formatWarning=${true}
        .steps=${[
          localize("common.success.step_eject"),
          ...this._steps(hardware),
          renderOpenHomeAssistantStep(),
          ...(writesHaos
            ? [
                selectedWifi(this._wizardState.selections)
                  ? localize("common.success.step_preparing_page_wifi")
                  : localize("common.success.step_preparing_page"),
              ]
            : []),
        ]}
        .footer=${html`<a
          href=${guide}
          target="_blank"
          rel="noopener noreferrer"
          @click=${openExternalLink}
          >${localize("views.ha_hardware.success_view.full_instructions", {
            device: haHardwareName(hardware),
          })}</a
        >`}
      ></install-success>
    `;
  }

  private _steps(hardware: HaHardwareId): (string | TemplateResult)[] {
    const wifi = selectedWifi(this._wizardState.selections);
    switch (hardware) {
      case "green":
        return [
          localize("views.ha_hardware.success_view.green_keep_internet"),
          localize("views.ha_hardware.success_view.green_shut_down"),
          localize("views.ha_hardware.success_view.green_insert_card"),
          localize("views.ha_hardware.success_view.green_power_on"),
          localize("views.ha_hardware.success_view.green_remove_card"),
        ];
      case "yellow-cm4":
        return [
          localize("views.ha_hardware.success_view.yellow_cm4_unplug_usb"),
          localize("views.ha_hardware.success_view.yellow_cm4_buttons"),
          localize("views.ha_hardware.success_view.yellow_cm4_insert_drive"),
          localize("views.ha_hardware.success_view.yellow_cm4_remove_drive"),
        ];
      case "yellow-cm5":
        return [
          localize("views.ha_hardware.success_view.yellow_cm5_unplug"),
          localize("views.ha_hardware.success_view.yellow_cm5_jp1"),
          wifi
            ? localize(
                "views.ha_hardware.success_view.yellow_cm5_power_on_wifi",
                { network: wifi.ssid }
              )
            : localize("views.ha_hardware.success_view.yellow_cm5_power_on"),
        ];
      case "blue":
        return [
          localize("views.ha_hardware.success_view.blue_restore"),
          localize("common.success.step_connect_ethernet_and_power"),
        ];
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-hardware-success-view": HaHardwareSuccessView;
  }
}
