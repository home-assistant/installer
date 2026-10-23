import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { WizardState } from "../../state/wizard-state.js";
import { WizardStateController } from "../../state/wizard-state-controller.js";
import {
  HOME_ASSISTANT_HOST,
  homeAssistantUrl,
  openExternalLink,
} from "../../utils/external-url.js";
import { selectedWifi } from "../../utils/wifi.js";

import "../../components/install-success.js";

const INSTALLATION_GUIDES: Record<string, string> = {
  "rpi3-64": "https://www.home-assistant.io/installation/raspberrypi/",
  "rpi4-64": "https://www.home-assistant.io/installation/raspberrypi/",
  "rpi5-64": "https://www.home-assistant.io/installation/raspberrypi/",
  "odroid-c2": "https://www.home-assistant.io/installation/odroid/",
  "odroid-c4": "https://www.home-assistant.io/installation/odroid/",
  "odroid-m1": "https://www.home-assistant.io/installation/odroid/",
  "odroid-n2":
    "https://www.home-assistant.io/installation/odroid/#flashing-an-odroid-n2",
  "odroid-m1s":
    "https://www.home-assistant.io/installation/odroid/#flashing-an-odroid-m1s",
  "generic-x86-64":
    "https://www.home-assistant.io/installation/generic-x86-64/",
  "generic-aarch64":
    "https://contributors.home-assistant.io/os/operating-system/generic/",
};

/** The last step after any write: where to find Home Assistant. */
export function renderOpenHomeAssistantStep() {
  return html`${localizeContent("views.sbc.success_view.step_open", {
    url: html`<a
      href=${homeAssistantUrl()}
      target="_blank"
      rel="noopener noreferrer"
      @click=${openExternalLink}
      >${HOME_ASSISTANT_HOST}</a
    >`,
    ip_url: html`<code dir="ltr"
      >http://&lt;<bdi>${localize(
        "views.sbc.success_view.ip_address"
      )}</bdi>&gt;</code
    >`,
  })}`;
}

@customElement("success-view")
export class SuccessView extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100%;
    }
  `;

  /**
   * Show the steps that fit any board, whatever device the selections still
   * name, for a flow that lost track of which one it was installing.
   */
  @property({ type: Boolean })
  generic = false;

  private readonly _wizard = new WizardStateController(this);

  private get _wizardState(): WizardState {
    return this._wizard.state;
  }

  render() {
    const { selections } = this._wizardState;
    const deviceName = this.generic ? undefined : selections.deviceName;
    const board = this.generic ? "" : (selections.deviceConfig?.board ?? "");
    const isMiniPc = this._wizardState.currentFlow === "minipc";
    const wifi = selectedWifi(selections);
    const supportsDirectUsb = board === "odroid-n2" || board === "odroid-m1s";
    const guide = Object.prototype.hasOwnProperty.call(
      INSTALLATION_GUIDES,
      board
    )
      ? INSTALLATION_GUIDES[board]
      : "https://www.home-assistant.io/installation/";

    return html`
      <install-success
        .subtitle=${localize("common.success.subtitle")}
        .formatWarning=${true}
        .steps=${[
          localize("common.success.step_eject"),
          isMiniPc
            ? localize("views.sbc.success_view.step_minipc_install_drive")
            : supportsDirectUsb
              ? html`${deviceName
                  ? localize(
                      "views.sbc.success_view.step_insert_or_disconnect",
                      { device: deviceName }
                    )
                  : localize(
                      "views.sbc.success_view.step_insert_or_disconnect_generic"
                    )}
                ${board === "odroid-m1s"
                  ? localize(
                      "views.sbc.success_view.remove_the_emmc2ums_sd_card"
                    )
                  : localize("views.sbc.success_view.step_boot_switch_to_mmc")}`
              : deviceName
                ? localize("views.sbc.success_view.step_insert_storage", {
                    device: deviceName,
                  })
                : localize(
                    "views.sbc.success_view.step_insert_storage_generic"
                  ),
          wifi
            ? localize("views.sbc.success_view.step_connect_power_wifi", {
                network: wifi.ssid,
              })
            : localize("common.success.step_connect_ethernet_and_power"),
          renderOpenHomeAssistantStep(),
          wifi
            ? localize("common.success.step_preparing_page_wifi")
            : localize("common.success.step_preparing_page"),
        ]}
        .footer=${html`<a
          href=${guide}
          target="_blank"
          rel="noopener noreferrer"
          @click=${openExternalLink}
          >${guide === "https://www.home-assistant.io/installation/"
            ? localize("views.sbc.success_view.installation_guide")
            : deviceName
              ? localize("views.sbc.success_view.device_installation_guide", {
                  device: deviceName,
                })
              : localize(
                  "views.sbc.success_view.your_device_installation_guide"
                )}</a
        >`}
      ></install-success>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "success-view": SuccessView;
  }
}
