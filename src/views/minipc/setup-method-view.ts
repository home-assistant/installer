import { localize } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { customElement } from "lit/decorators.js";
import {
  MINIPC_STEPS,
  minipcDirectSteps,
  wizardState,
} from "../../state/wizard-state.js";
import { goToNextStep } from "../../components/wizard-steps.js";
import "../../components/option-card.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";

@customElement("minipc-setup-method-view")
export class MiniPCSetupMethodView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    reducedMotionStyles,
    css`
      .options {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        width: 100%;
        max-width: 500px;
      }
    `,
  ];

  render() {
    return html`
      ${renderStepHeading(
        localize("views.minipc.setup_method_view.how_will_you_install"),
        localize("views.minipc.setup_method_view.subtitle")
      )}

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
    `;
  }

  private _onConnectDrive() {
    wizardState.setSteps(minipcDirectSteps(wizardState.getState().selections));
    wizardState.setSelection("installMethod", "direct");
    goToNextStep(this);
  }

  private _onUsbBoot() {
    wizardState.setSteps(MINIPC_STEPS.usb);
    wizardState.setSelection("installMethod", "usb-boot");
    goToNextStep(this);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "minipc-setup-method-view": MiniPCSetupMethodView;
  }
}
