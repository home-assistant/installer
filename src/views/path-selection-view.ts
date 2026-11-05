import { localize } from "../localization/localize.js";
import { LitElement, html, css } from "lit";
import { ViewAccessibility } from "../utils/view-accessibility.js";
import { customElement, state } from "lit/decorators.js";
import { pageStyles, renderBackHeader } from "../utils/page-header.js";
import { fireEvent } from "../utils/fire-event.js";

import "../components/option-card.js";
import { getPlatform } from "../utils/platform.js";
import { isUtmSupported } from "../api/commands.js";
import type { WizardFlow } from "../state/wizard-state.js";

@customElement("path-selection-view")
export class PathSelectionView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    pageStyles,
    css`
      .options-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 1.5rem;
        max-width: 900px;
        width: 100%;
      }
    `,
  ];

  /** Set on an Intel Mac, which can't run the UTM install. */
  @state()
  private _vmNeedsAppleSilicon = false;

  connectedCallback() {
    super.connectedCallback();
    if (getPlatform() === "macos") {
      void this._checkVMSupport();
    }
  }

  render() {
    return html`
      ${renderBackHeader(this._onBack)}

      <div class="content">
        <h1>${localize("views.path_selection_view.title")}</h1>
        <p class="subtitle">
          ${localize("views.path_selection_view.subtitle")}
        </p>

        <div class="options-grid">
          <option-card
            heading=${localize("common.home_assistant_hardware")}
            description=${localize(
              "views.path_selection_view.ha_hardware_description"
            )}
            icon="ha-hardware"
            data-path="ha-hardware"
            @click=${this._onSelectPath}
          ></option-card>

          <option-card
            heading=${localize("common.raspberry_pi_other_boards")}
            description=${localize("views.path_selection_view.sbc_description")}
            icon="sbc"
            data-path="sbc"
            @click=${this._onSelectPath}
          ></option-card>

          <option-card
            heading=${localize("common.generic_mini_pc")}
            description=${localize(
              "views.path_selection_view.minipc_description"
            )}
            icon="minipc"
            data-path="minipc"
            @click=${this._onSelectPath}
          ></option-card>

          <option-card
            heading=${localize("common.proxmox_server")}
            description=${localize(
              "views.path_selection_view.proxmox_description"
            )}
            icon="proxmox"
            data-path="proxmox"
            @click=${this._onSelectPath}
          ></option-card>

          ${this._renderVMOption()}

          <option-card
            heading=${localize("views.path_selection_view.others")}
            description=${localize(
              "views.path_selection_view.other_description"
            )}
            icon="others"
            @click=${this._onOtherOptions}
          ></option-card>
        </div>
      </div>
    `;
  }

  private _renderVMOption() {
    if (getPlatform() !== "macos") {
      return null;
    }

    return html`
      <option-card
        heading=${localize("common.virtual_machine")}
        description=${this._vmNeedsAppleSilicon
          ? localize("views.path_selection_view.needs_a_mac_with_apple_silicon")
          : localize("views.path_selection_view.utm_description")}
        icon="vm"
        data-path="vm"
        @click=${this._onSelectPath}
      ></option-card>
    `;
  }

  // The option stays selectable either way. It leads to the screen that
  // explains why, but now the card says so before anyone picks it.
  private async _checkVMSupport() {
    try {
      this._vmNeedsAppleSilicon = !(await isUtmSupported());
    } catch {
      // Keep the plain card; the next screen reports what went wrong
    }
  }

  private _onBack() {
    fireEvent(this, "navigate", { view: "welcome" });
  }

  private _onSelectPath(ev: Event) {
    const path = (ev.currentTarget as HTMLElement).dataset.path as WizardFlow;
    fireEvent(this, "select-path", { path });
  }

  private _onOtherOptions() {
    fireEvent(this, "navigate", { view: "other-options" });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "path-selection-view": PathSelectionView;
  }

  interface HAIEvents {
    "select-path": { path: WizardFlow };
  }
}
