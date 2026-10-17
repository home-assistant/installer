import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { revealInFolder } from "../../api/index.js";
import { wizardState } from "../../state/wizard-state.js";
import { openExternalLink } from "../../utils/external-url.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "../../components/install-success.js";

const GUIDE = "https://www.home-assistant.io/installation/generic-x86-64/";
const HOME_ASSISTANT = "http://homeassistant.local";

/** Next steps on the computer being installed, for a stick or for the saved ISO. */
@customElement("live-usb-success-view")
export class LiveUsbSuccessView extends LitElement {
  static styles = css`
    :host {
      display: block;
      height: 100%;
    }
  `;

  @state()
  private _revealFailed = false;

  private async _reveal(path: string) {
    this._revealFailed = false;
    try {
      await revealInFolder(path);
    } catch {
      this._revealFailed = true;
    }
  }

  render() {
    const selections = wizardState.getState().selections;
    const iso = selections.liveMedia === "iso";
    const path = selections.liveIsoPath ?? "";
    const boot = [
      iso
        ? localize("views.live_usb.success_view.iso_bios_settings")
        : localize("views.live_usb.success_view.bios_settings"),
      iso
        ? localize("views.live_usb.success_view.boot_from_media")
        : localize("views.live_usb.success_view.boot_from_usb"),
      localize("views.live_usb.success_view.pick_drive_and_erase"),
      iso
        ? localize("views.live_usb.success_view.iso_remove_and_restart")
        : localize("views.live_usb.success_view.remove_and_restart"),
      html`${localizeContent(
        "views.live_usb.success_view.open_home_assistant",
        {
          address: html`<a
            href=${HOME_ASSISTANT}
            target="_blank"
            rel="noopener noreferrer"
            @click=${(event: Event) => openExternalLink(event, HOME_ASSISTANT)}
            >${"homeassistant.local"}</a
          >`,
        }
      )}`,
    ];

    return html`
      <install-success
        .subtitle=${iso
          ? localize("views.live_usb.success_view.iso_saved")
          : localize("views.live_usb.success_view.usb_ready")}
        .notice=${iso
          ? html`<span
              class="saved-row"
              style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem"
            >
              <span class="saved"
                >${localize("views.live_usb.success_view.saved_to", {
                  path,
                })}</span
              >
              ${path
                ? html`<wa-button
                    size="small"
                    appearance="outlined"
                    @click=${() => this._reveal(path)}
                    >${localize(
                      "views.live_usb.success_view.show_in_folder"
                    )}</wa-button
                  >`
                : ""}
              ${this._revealFailed
                ? html`<span role="alert"
                    >${localize(
                      "views.live_usb.success_view.show_failed"
                    )}</span
                  >`
                : ""}
            </span>`
          : localize("views.live_usb.success_view.do_not_format")}
        .steps=${iso
          ? [localize("views.live_usb.success_view.write_the_iso"), ...boot]
          : [
              localize(
                "views.sbc.success_view.eject_the_drive_before_disconnecting"
              ),
              localize("views.live_usb.success_view.plug_in_the_stick"),
              ...boot,
            ]}
        .footer=${html`<a
          href=${GUIDE}
          target="_blank"
          rel="noopener noreferrer"
          @click=${(event: Event) => openExternalLink(event, GUIDE)}
          >${localize("views.sbc.success_view.installation_guide")}</a
        >`}
      ></install-success>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "live-usb-success-view": LiveUsbSuccessView;
  }
}
