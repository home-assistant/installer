import { localize } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { MINIPC_STEPS, wizardState } from "../../state/wizard-state.js";
import { clearDriveSelection } from "../../utils/drive-selection.js";
import type { HaosConfig } from "../../api/types.js";
import "../../components/option-card.js";

/** Drive rules for the stick: removable and 2 GB or more (the drive list allows 5% less). */
const LIVE_USB_STICK: HaosConfig = {
  board: "generic-x86-64",
  minimum_storage_bytes: 2_000_000_000,
  recommended_storage_bytes: 2_000_000_000,
};

@customElement("minipc-media-view")
export class MiniPCMediaView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = css`
    ${reducedMotionStyles}
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
  `;

  render() {
    return html`
      <h2>${localize("views.minipc.media_view.create_bootable_media")}</h2>
      <p class="subtitle">${localize("views.minipc.media_view.subtitle")}</p>

      <div class="options">
        <option-card
          horizontal
          heading=${localize("views.minipc.media_view.write_to_a_usb_stick")}
          description=${localize(
            "views.minipc.media_view.write_to_a_usb_stick_description"
          )}
          icon="usb-boot"
          @click=${this._chooseUsb}
          ><span slot="end" aria-hidden="true">→</span></option-card
        >
        <option-card
          horizontal
          heading=${localize("views.minipc.media_view.save_an_iso_file")}
          description=${localize(
            "views.minipc.media_view.save_an_iso_file_description"
          )}
          icon="disc"
          @click=${this._chooseIso}
          ><span slot="end" aria-hidden="true">→</span></option-card
        >
      </div>
    `;
  }

  private _chooseUsb() {
    this._choose("usb");
  }

  private _chooseIso() {
    this._choose("iso");
  }

  private _choose(media: "usb" | "iso") {
    // A drive picked earlier (perhaps an SSD on the other path) must be picked again.
    clearDriveSelection();
    // The stick replaces the board's drive rules, so the direct path must pick its board again.
    wizardState.setSelection("device", undefined);
    wizardState.setSelection(
      "deviceConfig",
      media === "usb" ? LIVE_USB_STICK : undefined
    );
    wizardState.setSteps(MINIPC_STEPS[media]);
    wizardState.setSelection("liveMedia", media);
    wizardState.nextStep();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "minipc-media-view": MiniPCMediaView;
  }
}
