import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { revealInFolder } from "../../api/index.js";
import type { WizardState } from "../../state/wizard-state.js";
import { WizardStateController } from "../../state/wizard-state-controller.js";
import { renderExternalLink } from "../../utils/external-link.js";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { DeviceSurvey } from "../../utils/device-discovery.js";
import { GENERIC_X86_GUIDE_URL } from "../../utils/urls.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "../../components/install-success.js";

/** Next steps on the computer being installed, for a stick or for the saved ISO. */
@customElement("live-usb-success-view")
export class LiveUsbSuccessView extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100%;
    }

    /* Lined up with the next steps above it */
    .saved-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 1rem;
      margin-bottom: 1.5rem;
      text-align: start;
      overflow-wrap: anywhere;
    }

    /* On a line of its own, under the button that failed */
    .reveal-error {
      flex-basis: 100%;
      margin: 0;
      color: var(--ha-error-color);
    }
  `;

  // Focuses the folder that couldn't be shown, which reads it out.
  // install-success focuses its own heading.
  protected readonly _accessibility = new ViewAccessibility(this);

  private readonly _wizard = new WizardStateController(this);

  private get _wizardState(): WizardState {
    return this._wizard.state;
  }

  // Notes what is on the network before the computer starts Home Assistant
  protected readonly _survey = new DeviceSurvey(this);

  @state()
  private _revealFailed = false;

  // install-success renders the button, so a plain method would get its `this`
  private _onReveal = () => void this._reveal();

  private async _reveal() {
    const path = this._wizardState.selections.liveIsoPath;
    if (!path) return;
    this._revealFailed = false;
    try {
      await revealInFolder(path);
    } catch {
      this._revealFailed = true;
    }
  }

  render() {
    const { selections } = this._wizardState;
    const iso = selections.liveMedia === "iso";
    const path = selections.liveIsoPath ?? "";
    const boot = [
      iso
        ? localize("views.live_usb.live_usb_success_view.iso_bios_settings")
        : localize("views.live_usb.live_usb_success_view.bios_settings"),
      iso
        ? localize("views.live_usb.live_usb_success_view.boot_from_media")
        : localize("views.live_usb.live_usb_success_view.boot_from_usb"),
      localize("views.live_usb.live_usb_success_view.pick_drive_and_erase"),
      iso
        ? localize(
            "views.live_usb.live_usb_success_view.iso_remove_and_restart"
          )
        : localize("views.live_usb.live_usb_success_view.remove_and_restart"),
      localize("common.success.step_next"),
    ];

    return html`
      <install-success
        .heading=${localize("common.success.almost_there")}
        .subtitle=${iso
          ? localize("views.live_usb.live_usb_success_view.iso_saved")
          : localize("views.live_usb.live_usb_success_view.usb_ready")}
        .formatWarning=${!iso}
        .companion=${false}
        .steps=${iso
          ? [
              localize("views.live_usb.live_usb_success_view.write_the_iso"),
              ...boot,
            ]
          : [
              localize("common.success.step_eject"),
              localize(
                "views.live_usb.live_usb_success_view.plug_in_the_stick"
              ),
              ...boot,
            ]}
        .footer=${renderExternalLink(
          GENERIC_X86_GUIDE_URL,
          localize("views.live_usb.live_usb_success_view.installation_guide")
        )}
      >
        ${iso
          ? html`<div class="saved-row">
              <span
                >${localizeContent(
                  "views.live_usb.live_usb_success_view.saved_to",
                  { path: html`<bdi dir="ltr">${path}</bdi>` }
                )}</span
              >
              ${path
                ? html`<wa-button
                    size="s"
                    appearance="outlined"
                    @click=${this._onReveal}
                    >${localize(
                      "views.live_usb.live_usb_success_view.show_in_folder"
                    )}</wa-button
                  >`
                : ""}
              ${this._revealFailed
                ? html`<p class="reveal-error" data-focus-alert>
                    ${localize(
                      "views.live_usb.live_usb_success_view.show_failed"
                    )}
                  </p>`
                : ""}
            </div>`
          : ""}
      </install-success>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "live-usb-success-view": LiveUsbSuccessView;
  }
}
