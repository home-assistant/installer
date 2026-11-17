import { localize } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { customElement } from "lit/decorators.js";
import { minipcDirectSteps, wizardState } from "../../state/wizard-state.js";
import { clearDriveSelection } from "../../utils/drive-selection.js";
import type { HaosConfig } from "../../api/types.js";
import { goToNextStep } from "../../components/wizard-next.js";
import "../../components/option-card.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";

/** Drive rules for the stick: removable and 2 GB or more (the drive list allows 5% less). */
const LIVE_USB_STICK: HaosConfig = {
  board: "generic-x86-64",
  minimum_storage_bytes: 2_000_000_000,
  recommended_storage_bytes: 2_000_000_000,
};

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
        max-width: var(--ha-content-width);
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
            "views.minipc.setup_method_view.create_a_usb_installer"
          )}
          description=${localize(
            "views.minipc.setup_method_view.create_a_usb_installer_description"
          )}
          tag=${localize("views.minipc.setup_method_view.recommended")}
          icon="usb-boot"
          @click=${this._onUsbStick}
          ><span slot="end" aria-hidden="true">→</span></option-card
        >
        <option-card
          horizontal
          heading=${localize(
            "views.minipc.setup_method_view.write_the_drive_here"
          )}
          description=${localize(
            "views.minipc.setup_method_view.write_the_drive_here_description"
          )}
          icon="drive-connect"
          @click=${this._onConnectDrive}
          ><span slot="end" aria-hidden="true">→</span></option-card
        >
        <option-card
          horizontal
          heading=${localize("views.minipc.setup_method_view.save_an_iso_file")}
          description=${localize(
            "views.minipc.setup_method_view.save_an_iso_file_description"
          )}
          icon="disc"
          @click=${this._onIsoFile}
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

  private _onUsbStick() {
    this._bootFromUsb("usb");
  }

  private _onIsoFile() {
    this._bootFromUsb("iso");
  }

  private _bootFromUsb(media: "usb" | "iso") {
    // A drive picked earlier (perhaps an SSD on the other path) must be picked again.
    clearDriveSelection();
    wizardState.setSelections({
      installMethod: "usb-boot",
      liveMedia: media,
      // The stick replaces the board's drive rules, so the direct path must pick its board again.
      device: undefined,
      deviceConfig: media === "usb" ? LIVE_USB_STICK : undefined,
    });
    goToNextStep(this);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "minipc-setup-method-view": MiniPCSetupMethodView;
  }
}
