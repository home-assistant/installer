import { localize } from "../../localization/localize.js";
import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import type { WizardState } from "../../state/wizard-state.js";
import { WizardStateController } from "../../state/wizard-state-controller.js";
import { renderExternalLink } from "../../utils/external-link.js";
import {
  GREEN_GUIDE_URL,
  ODROID_GUIDE_URL,
  YELLOW_CM4_GUIDE_URL,
  YELLOW_CM5_GUIDE_URL,
} from "../../utils/urls.js";
import { selectedWifi } from "../../utils/wifi.js";
import {
  findHaHardware,
  haHardwareName,
  type HaHardwareId,
} from "../../state/ha-hardware.js";

import "../../components/home-assistant-status.js";
import "../../components/install-success.js";
// The steps that fit any device, without one picked
import "../sbc/success-view.js";

const GUIDES: Record<HaHardwareId, string> = {
  green: GREEN_GUIDE_URL,
  "yellow-cm4": YELLOW_CM4_GUIDE_URL,
  "yellow-cm5": YELLOW_CM5_GUIDE_URL,
  blue: ODROID_GUIDE_URL,
};

@customElement("ha-hardware-success-view")
export class HaHardwareSuccessView extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100%;
    }
  `;

  private readonly _wizard = new WizardStateController(this);

  private get _wizardState(): WizardState {
    return this._wizard.state;
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
          selectedWifi(this._wizardState.selections)
            ? localize("common.success.step_follow_wifi")
            : localize("common.success.step_follow"),
        ]}
        .footer=${renderExternalLink(
          guide,
          localize("views.ha_hardware.success_view.full_instructions", {
            device: haHardwareName(hardware),
          })
        )}
      >
        <home-assistant-status></home-assistant-status>
      </install-success>
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
