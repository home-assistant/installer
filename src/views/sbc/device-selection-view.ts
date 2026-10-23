import { localize } from "../../localization/localize.js";
import { linkStyles } from "../../utils/link-styles.js";
import { LitElement, html } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { customElement } from "lit/decorators.js";
import type { Device, DeviceCategory } from "../../api/index.js";
import "../../components/device-card.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";
import { loadStateStyles } from "../../utils/load-state.js";
import {
  DeviceCatalog,
  deviceGridStyles,
  deviceSelections,
} from "../../utils/device-catalog.js";

/** The single board computers in the catalog */
const SBC_CATEGORIES: DeviceCategory[] = [
  "raspberry_pi",
  "odroid",
  "khadas",
  "asus",
];

@customElement("device-selection-view")
export class DeviceSelectionView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    loadStateStyles,
    reducedMotionStyles,
    linkStyles,
    deviceGridStyles,
  ];

  private readonly _catalog = new DeviceCatalog<Device>(
    this,
    this._accessibility,
    {
      offer: (manifest) =>
        manifest.devices.filter((device) =>
          SBC_CATEGORIES.includes(device.category)
        ),
      id: (device) => device.id,
      selections: deviceSelections,
    }
  );

  render() {
    return html`
      ${renderStepHeading(
        localize("views.sbc.device_selection_view.select_your_device"),
        localize("views.sbc.device_selection_view.subtitle")
      )}
      ${this._catalog.render(
        () => html`
          <div
            class="devices-grid"
            role="group"
            aria-label=${localize(
              "views.sbc.device_selection_view.single_board_computer"
            )}
          >
            ${this._catalog.devices.map(
              (device) => html`
                <device-card
                  .value=${device.id}
                  .name=${device.name}
                  .image=${device.image_url || ""}
                  @click=${this._catalog.onPick}
                ></device-card>
              `
            )}
          </div>
        `
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "device-selection-view": DeviceSelectionView;
  }
}
