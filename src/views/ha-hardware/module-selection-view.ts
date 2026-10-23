import { localize } from "../../localization/localize.js";
import { LitElement, html } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { optionCardStyles } from "../../utils/option-card-styles.js";
import { customElement } from "lit/decorators.js";
import { wizardState } from "../../state/wizard-state.js";
import { clearDriveSelection } from "../../utils/drive-selection.js";
import {
  haHardwareName,
  type YellowModuleId,
} from "../../state/ha-hardware.js";
import { goToNextStep } from "../../components/wizard-steps.js";
import "../../components/option-card.js";
import type { OptionCard } from "../../components/option-card.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";

/**
 * Picks the compute module in a Yellow, after the device step. Each module is
 * prepared differently, so this decides the hardware, its board and its drive.
 */
@customElement("ha-hardware-module-selection-view")
export class HaHardwareModuleSelectionView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [stepStyles, reducedMotionStyles, optionCardStyles];

  connectedCallback() {
    super.connectedCallback();
    const { haHardware } = wizardState.getState().selections;
    const module = this._modules().find(({ id }) => id === haHardware);
    if (module) {
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
      ${renderStepHeading(
        localize(
          "views.ha_hardware.module_selection_view.select_your_compute_module"
        ),
        localize(
          "views.ha_hardware.module_selection_view.yellow_compute_module_hint"
        )
      )}

      <div
        class="options"
        role="group"
        aria-label=${localize(
          "views.ha_hardware.module_selection_view.compute_module"
        )}
      >
        ${this._modules().map(
          ({ id }) => html`
            <option-card
              heading=${moduleName(id)}
              description=${moduleDescription(id)}
              icon="chip"
              .value=${id}
              @click=${this._onPickModule}
            ></option-card>
          `
        )}
      </div>
    `;
  }

  private _modules() {
    return wizardState.getState().selections.yellowModules ?? [];
  }

  private _onPickModule(e: Event) {
    const id = (e.currentTarget as OptionCard).value;
    const module = this._modules().find((module) => module.id === id);
    if (!module) return;
    const previous = wizardState.getState().selections.haHardware;
    wizardState.setSelections({
      haHardware: module.id,
      deviceName: haHardwareName(module.id),
      deviceConfig: module.config,
    });
    // The CM4 is installed from a USB flash drive, the CM5 from its own eMMC
    if (previous !== module.id) clearDriveSelection();
    goToNextStep(this);
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
