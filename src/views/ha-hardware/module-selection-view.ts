import { localize } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { optionCardStyles } from "../../utils/option-card-styles.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState } from "../../state/wizard-state.js";
import { clearDriveSelection } from "../../utils/drive-selection.js";
import { haHardwareName, type YellowModuleId } from "./hardware.js";
import "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import "@home-assistant/webawesome/dist/components/radio/radio.js";

/**
 * Picks the compute module in a Yellow, after the device step. Each module is
 * prepared differently, so this decides the hardware, its board and its drive.
 */
@customElement("ha-hardware-module-selection-view")
export class HaHardwareModuleSelectionView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    reducedMotionStyles,
    optionCardStyles,
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
    `,
  ];

  @state()
  private _selected?: YellowModuleId;

  connectedCallback() {
    super.connectedCallback();
    const { haHardware } = wizardState.getState().selections;
    const module = this._modules().find(({ id }) => id === haHardware);
    if (module) {
      this._selected = module.id;
      // The device step reloads the catalog, which may have changed its storage
      wizardState.setSelection("deviceConfig", module.config);
    } else if (haHardware) {
      // The catalog no longer offers the module picked before
      wizardState.setSelections({
        haHardware: undefined,
        deviceConfig: undefined,
      });
      clearDriveSelection();
    }
  }

  render() {
    return html`
      <h2>
        ${localize(
          "views.ha_hardware.module_selection_view.select_your_compute_module"
        )}
      </h2>
      <p class="subtitle">
        ${localize(
          "views.ha_hardware.module_selection_view.yellow_compute_module_hint"
        )}
      </p>

      <wa-radio-group
        class="options"
        orientation="horizontal"
        label=${localize(
          "views.ha_hardware.module_selection_view.compute_module"
        )}
        .value=${this._selected ?? ""}
        @change=${this._onModuleChange}
      >
        ${this._modules().map(
          ({ id }) => html`
            <wa-radio appearance="button" .value=${id}>
              <div class="option-icon">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M6,4H18V5H21V7H18V9H21V11H18V13H21V15H18V17H21V19H18V20H6V19H3V17H6V15H3V13H6V11H3V9H6V7H3V5H6V4M11,15V18H12V15H11M13,15V18H14V15H13M15,15V18H16V15H15Z"
                  />
                </svg>
              </div>
              <div>
                <p class="option-title">${moduleName(id)}</p>
                <p class="option-description">${moduleDescription(id)}</p>
              </div>
            </wa-radio>
          `
        )}
      </wa-radio-group>
    `;
  }

  private _modules() {
    return wizardState.getState().selections.yellowModules ?? [];
  }

  private _onModuleChange(e: Event) {
    const id = (e.target as { value?: string }).value;
    const module = this._modules().find((module) => module.id === id);
    if (!module) return;
    const previous = wizardState.getState().selections.haHardware;
    this._selected = module.id;
    wizardState.setSelections({
      haHardware: module.id,
      deviceName: haHardwareName(module.id),
      deviceConfig: module.config,
    });
    // The CM4 is installed from a USB flash drive, the CM5 from its own eMMC
    if (previous !== module.id) clearDriveSelection();
  }
}

function moduleName(id: YellowModuleId): string {
  switch (id) {
    case "yellow-cm4":
      return localize("views.ha_hardware.module_selection_view.cm4");
    case "yellow-cm5":
      return localize("views.ha_hardware.module_selection_view.cm5");
  }
}

function moduleDescription(id: YellowModuleId): string {
  switch (id) {
    case "yellow-cm4":
      return localize(
        "views.ha_hardware.module_selection_view.cm4_description"
      );
    case "yellow-cm5":
      return localize(
        "views.ha_hardware.module_selection_view.cm5_description"
      );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-hardware-module-selection-view": HaHardwareModuleSelectionView;
  }
}
