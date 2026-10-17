import { localize } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { customElement } from "lit/decorators.js";
import { MINIPC_STEPS, wizardState } from "../../state/wizard-state.js";
import "../../components/option-card.js";

@customElement("minipc-setup-method-view")
export class MiniPCSetupMethodView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = css`
    ${reducedMotionStyles}
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
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
  `;

  render() {
    return html`
      <h2>
        ${localize("views.minipc.setup_method_view.how_will_you_install")}
      </h2>
      <p class="subtitle">
        ${localize(
          "views.minipc.setup_method_view.choose_how_you_want_to_install_home_assistant_on_your_mini_pc"
        )}
      </p>

      <div class="options">
        <option-card
          horizontal
          title=${localize(
            "views.minipc.setup_method_view.i_can_connect_the_drive"
          )}
          description=${localize(
            "views.minipc.setup_method_view.connect_the_ssd_or_nvme_drive_from_your_mini_pc_to_this_computer_via_usb_ad"
          )}
          image="/assets/icons/drive-connect.svg"
          @click=${this._onConnectDrive}
          ><span slot="end" aria-hidden="true">→</span></option-card
        >
        <option-card
          horizontal
          title=${localize(
            "views.minipc.setup_method_view.i_need_to_boot_from_usb"
          )}
          description=${localize(
            "views.minipc.setup_method_view.create_a_bootable_usb_drive_to_install_home_assistant_directly_on_the_mini_"
          )}
          image="/assets/icons/usb-boot.svg"
          @click=${this._onUsbBoot}
          ><span slot="end" aria-hidden="true">→</span></option-card
        >
      </div>
    `;
  }

  private _onConnectDrive() {
    wizardState.setSteps(MINIPC_STEPS.direct);
    wizardState.setSelection("installMethod", "direct");
    wizardState.nextStep();
  }

  private _onUsbBoot() {
    wizardState.setSteps(MINIPC_STEPS.usb);
    wizardState.setSelection("installMethod", "usb-boot");
    wizardState.nextStep();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "minipc-setup-method-view": MiniPCSetupMethodView;
  }
}
