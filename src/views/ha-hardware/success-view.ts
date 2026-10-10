import { localize } from "../../localization/localize.js";
import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { openExternalLink } from "../../utils/external-url.js";
import { renderOpenHomeAssistantStep } from "../sbc/success-view.js";
import { haHardwareName, type HaHardwareId } from "./hardware.js";

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
      height: 100%;
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
    const hardware = this._wizardState.selections.haHardware ?? "green";
    const guide = GUIDES[hardware];

    return html`
      <install-success
        .subtitle=${hardware === "blue"
          ? localize(
              "views.sbc.success_view.home_assistant_os_has_been_written_to_your_storage_device"
            )
          : localize(
              "views.ha_hardware.success_view.the_installer_has_been_written_to_your_drive"
            )}
        .notice=${localize(
          "views.sbc.success_view.do_not_format_or_initialize_the_written_drive"
        )}
        .steps=${[
          localize(
            "views.sbc.success_view.eject_the_drive_before_disconnecting"
          ),
          ...this._steps(hardware),
          renderOpenHomeAssistantStep(),
          ...(hardware === "blue"
            ? [
                localize(
                  "views.sbc.success_view.the_preparing_home_assistant_page"
                ),
              ]
            : []),
        ]}
        .footer=${html`<a
          href=${guide}
          target="_blank"
          rel="noopener noreferrer"
          @click=${(event: Event) => openExternalLink(event, guide)}
          >${localize("views.ha_hardware.success_view.full_instructions", {
            device: haHardwareName(hardware),
          })}</a
        >`}
      ></install-success>
    `;
  }

  private _steps(hardware: HaHardwareId): (string | TemplateResult)[] {
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
          localize("views.ha_hardware.success_view.yellow_cm5_power_on"),
        ];
      case "blue":
        return [
          localize("views.ha_hardware.success_view.blue_restore"),
          localize("views.sbc.success_view.connect_ethernet_and_power"),
        ];
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-hardware-success-view": HaHardwareSuccessView;
  }
}
