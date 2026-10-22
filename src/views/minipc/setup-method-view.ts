import { localize } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState } from "../../state/wizard-state.js";
import { openExternalUrl } from "../../utils/external-url.js";
import "../../components/info-dialog.js";
import "../../components/option-card.js";

@customElement("minipc-setup-method-view")
export class MiniPCSetupMethodView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    reducedMotionStyles,
    css`
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
        margin: 0 0 2rem 0;
        text-align: center;
        max-width: 500px;
      }

      .options {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        width: 100%;
        max-width: 500px;
      }
    `,
  ];

  @state()
  private _showUsbDialog = false;

  render() {
    return html`
      <h2>
        ${localize("views.minipc.setup_method_view.how_will_you_install")}
      </h2>
      <p class="subtitle">
        ${localize("views.minipc.setup_method_view.subtitle")}
      </p>

      <div class="options">
        <option-card
          horizontal
          heading=${localize(
            "views.minipc.setup_method_view.i_can_connect_the_drive"
          )}
          description=${localize(
            "views.minipc.setup_method_view.connect_drive_description"
          )}
          icon="drive-connect"
          @click=${this._onConnectDrive}
          ><span slot="end" aria-hidden="true">→</span></option-card
        >
        <option-card
          horizontal
          heading=${localize(
            "views.minipc.setup_method_view.i_need_to_boot_from_usb"
          )}
          description=${localize(
            "views.minipc.setup_method_view.boot_from_usb_description"
          )}
          icon="usb-boot"
          @click=${this._onUsbBoot}
          ><span slot="end" aria-hidden="true">→</span></option-card
        >
      </div>

      <info-dialog
        ?open=${this._showUsbDialog}
        heading=${localize(
          "views.minipc.setup_method_view.usb_boot_installation"
        )}
        message=${localize(
          "views.minipc.setup_method_view.boot_from_usb_unsupported"
        )}
        primary-label=${localize("common.view_instructions")}
        secondary-label=${localize("common.go_back")}
        @dialog-primary=${this._onOpenDocs}
        @dialog-secondary=${this._onCloseDialog}
      ></info-dialog>
    `;
  }

  private _onConnectDrive() {
    wizardState.nextStep();
  }

  private _onUsbBoot() {
    this._showUsbDialog = true;
  }

  private _onCloseDialog() {
    this._showUsbDialog = false;
  }

  private async _onOpenDocs() {
    this._showUsbDialog = false;
    await openExternalUrl(
      "https://www.home-assistant.io/installation/generic-x86-64"
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "minipc-setup-method-view": MiniPCSetupMethodView;
  }
}
