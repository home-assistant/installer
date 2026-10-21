import { localize } from "../localization/localize.js";
import { LitElement, html, css } from "lit";
import { ViewAccessibility } from "../utils/view-accessibility.js";
import { customElement, state } from "lit/decorators.js";
import { pageHeaderStyles } from "../utils/page-header.js";

import "@home-assistant/webawesome/dist/components/button/button.js";
import "../components/option-card.js";
import { getPlatform } from "../utils/platform.js";
import { isUtmSupported } from "../api/commands.js";

export type InstallationPath =
  | "sbc"
  | "minipc"
  | "ha-hardware"
  | "proxmox"
  | "vm";

@customElement("path-selection-view")
export class PathSelectionView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = css`
    ${pageHeaderStyles}
    :host {
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      height: 100%;
    }

    .content {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      overflow-y: auto;
      padding: 1rem 2rem 2rem;
    }

    /* The auto margins center the options while they fit; once they don't,
       the list scrolls from the top instead of being cut off */
    h1 {
      font-size: 1.75rem;
      font-weight: 400;
      color: var(--ha-text-color, #212121);
      margin: auto 0 0.5rem 0;
      text-align: center;
    }

    .subtitle {
      font-size: 1rem;
      color: var(--ha-secondary-text-color, #727272);
      margin: 0 0 2rem 0;
      text-align: center;
    }

    .options-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1.5rem;
      max-width: 900px;
      width: 100%;
      margin-bottom: auto;
    }

    .other-options {
      margin-top: 2rem;
      font-size: 0.875rem;
      color: var(--ha-secondary-text-color, #9e9e9e);
      text-decoration: underline;
      cursor: pointer;
    }

    .other-options:hover {
      color: var(--ha-primary-color, #03a9f4);
    }
  `;

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
      <div class="header">
        <wa-button appearance="plain" @click=${this._onBack}>
          <span slot="start">←</span> ${localize("common.back")}
        </wa-button>
      </div>

      <div class="content">
        <h1>
          ${localize(
            "views.path_selection_view.what_would_you_like_to_install_on"
          )}
        </h1>
        <p class="subtitle">
          ${localize(
            "views.path_selection_view.select_how_you_want_to_run_home_assistant"
          )}
        </p>

        <div class="options-grid">
          <option-card
            title=${localize("components.app_shell.home_assistant_hardware")}
            description=${localize(
              "views.path_selection_view.home_assistant_green_yellow_or_blue_by_nabu_casa"
            )}
            icon="ha-hardware"
            @click=${() => this._onSelectPath("ha-hardware")}
          ></option-card>

          <option-card
            title=${localize("components.app_shell.raspberry_pi_other_boards")}
            description=${localize(
              "views.path_selection_view.single_board_computers_like_raspberry_pi_odroid_and_more"
            )}
            icon="sbc"
            @click=${() => this._onSelectPath("sbc")}
          ></option-card>

          <option-card
            title=${localize("components.app_shell.generic_mini_pc")}
            description=${localize(
              "views.path_selection_view.x86_64_or_arm64_computers_like_beelink_intel_nuc_and_more"
            )}
            icon="minipc"
            @click=${() => this._onSelectPath("minipc")}
          ></option-card>

          <option-card
            title=${localize("components.app_shell.proxmox_server")}
            description=${localize(
              "views.path_selection_view.create_a_vm_on_your_proxmox_virtualization_server"
            )}
            icon="proxmox"
            @click=${() => this._onSelectPath("proxmox")}
          ></option-card>

          ${this._renderVMOption()}

          <option-card
            title=${localize("views.path_selection_view.others")}
            description=${localize(
              "views.path_selection_view.other_options_like_docker_can_be_found_in_our_documentation"
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
        title=${localize("components.app_shell.virtual_machine")}
        description=${this._vmNeedsAppleSilicon
          ? localize("views.path_selection_view.needs_a_mac_with_apple_silicon")
          : localize(
              "views.path_selection_view.run_home_assistant_in_utm_on_your_mac"
            )}
        icon="vm"
        @click=${() => this._onSelectPath("vm")}
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
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { view: "welcome" },
        bubbles: true,
        composed: true,
      })
    );
  }

  private _onSelectPath(path: InstallationPath) {
    this.dispatchEvent(
      new CustomEvent("select-path", {
        detail: { path },
        bubbles: true,
        composed: true,
      })
    );
  }

  private _onOtherOptions() {
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { view: "other-options" },
        bubbles: true,
        composed: true,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "path-selection-view": PathSelectionView;
  }
}
