import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { openExternalLink } from "../../utils/external-url.js";

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
    "https://developers.home-assistant.io/docs/operating-system/boards/generic-aarch64/",
};

@customElement("success-view")
export class SuccessView extends LitElement {
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
    const deviceName = this._wizardState.selections.deviceName as
      | string
      | undefined;
    const board = this._wizardState.selections.deviceConfig?.board ?? "";
    const isMiniPc = this._wizardState.currentFlow === "minipc";
    const supportsDirectUsb = board === "odroid-n2" || board === "odroid-m1s";
    const guide = Object.prototype.hasOwnProperty.call(
      INSTALLATION_GUIDES,
      board
    )
      ? INSTALLATION_GUIDES[board]
      : "https://www.home-assistant.io/installation/";

    return html`
      <install-success
        .subtitle=${localize(
          "views.sbc.success_view.home_assistant_os_has_been_written_to_your_storage_device"
        )}
        .notice=${localize(
          "views.sbc.success_view.do_not_format_or_initialize_the_written_drive"
        )}
        .steps=${[
          localize(
            "views.sbc.success_view.eject_the_drive_before_disconnecting"
          ),
          isMiniPc
            ? localize(
                "views.sbc.success_view.install_the_drive_in_your_mini_pc"
              )
            : supportsDirectUsb
              ? html`${deviceName
                  ? localize(
                      "views.sbc.success_view.insert_the_media_or_disconnect_usb",
                      { value0: deviceName }
                    )
                  : localize(
                      "views.sbc.success_view.insert_the_media_or_disconnect_usb_unknown_device"
                    )}
                ${board === "odroid-m1s"
                  ? localize(
                      "views.sbc.success_view.remove_the_emmc2ums_sd_card"
                    )
                  : localize(
                      "views.sbc.success_view.set_the_boot_mode_switch_back_to_mmc"
                    )}`
              : deviceName
                ? localize(
                    "views.sbc.success_view.insert_the_written_storage",
                    {
                      value0: deviceName,
                    }
                  )
                : localize(
                    "views.sbc.success_view.insert_the_written_storage_unknown_device"
                  ),
          localize("views.sbc.success_view.connect_ethernet_and_power"),
          html`${localizeContent(
            "views.sbc.success_view.open_value_in_your_browser_or_find_the_ip_address",
            {
              value0: html`<a
                href="http://homeassistant.local:8123"
                target="_blank"
                rel="noopener noreferrer"
                @click=${(event: Event) =>
                  openExternalLink(event, "http://homeassistant.local:8123")}
                >${"homeassistant.local:8123"}</a
              >`,
              value1: html`<code
                >http://&lt;${localize(
                  "views.sbc.success_view.ip_address"
                )}&gt;:8123</code
              >`,
            }
          )}`,
          localize("views.sbc.success_view.the_preparing_home_assistant_page"),
        ]}
        .footer=${html`<a
          href=${guide}
          target="_blank"
          rel="noopener noreferrer"
          @click=${(event: Event) => openExternalLink(event, guide)}
          >${guide === "https://www.home-assistant.io/installation/"
            ? localize("views.sbc.success_view.installation_guide")
            : deviceName
              ? localize("views.sbc.success_view.value_installation_guide", {
                  value0: deviceName,
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
