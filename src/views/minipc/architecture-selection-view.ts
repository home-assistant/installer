import { localize, localizeContent } from "../../localization/localize.js";
import { linkStyles } from "../../utils/link-styles.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { optionCardStyles } from "../../utils/option-card-styles.js";
import { customElement, state } from "lit/decorators.js";
import {
  isUtmSupported,
  type Device,
  type DeviceCategory,
} from "../../api/index.js";
import { getPlatform } from "../../utils/platform.js";
import "../../components/option-card.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";
import { loadStateStyles } from "../../utils/load-state.js";
import { DeviceCatalog, deviceSelections } from "../../utils/device-catalog.js";

/** The catalog's generic images, one for each processor architecture */
const ARCHITECTURES: DeviceCategory[] = ["generic_x86", "generic_arm64"];

@customElement("minipc-architecture-selection-view")
export class MiniPCArchitectureSelectionView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    loadStateStyles,
    reducedMotionStyles,
    linkStyles,
    optionCardStyles,
    css`
      .mac-note {
        font-size: 1rem;
        color: var(--ha-secondary-text-color);
        margin: 1rem 0 2rem 0;
        text-align: center;
        max-width: var(--ha-content-width);
      }

      .option-examples {
        font-size: 0.8125rem;
        color: var(--ha-secondary-text-color);
        text-align: center;
        margin: 0.75rem 0 0 0;
        line-height: 1.4;
      }
    `,
  ];

  private readonly _catalog = new DeviceCatalog<Device>(
    this,
    this._accessibility,
    {
      offer: (manifest) =>
        ARCHITECTURES.flatMap((category) => {
          const device = manifest.devices.find(
            (device) => device.category === category
          );
          return device ? [device] : [];
        }),
      id: (device) => device.id,
      selections: deviceSelections,
      loadingLabel: () =>
        localize(
          "views.minipc.architecture_selection_view.loading_architectures"
        ),
      failedMessage: () =>
        localize(
          "views.minipc.architecture_selection_view.failed_to_load_architectures"
        ),
    }
  );

  /** Intel Macs can't run the UTM install the note points to. */
  @state()
  private _utmSupported = false;

  connectedCallback() {
    super.connectedCallback();
    // Only a Mac can run UTM, so no other computer has to ask. The note is
    // an aside, so the architectures don't wait for it.
    if (getPlatform() === "macos") {
      void isUtmSupported().then(
        (supported) => {
          this._utmSupported = supported;
        },
        // Leave the note out
        () => undefined
      );
    }
  }

  render() {
    return html`
      ${renderStepHeading(
        localize("views.minipc.architecture_selection_view.title"),
        localize("views.minipc.architecture_selection_view.subtitle")
      )}
      ${this._catalog.render(() => this._renderChoices())}
    `;
  }

  private _renderChoices() {
    const x86Device = this._architecture("generic_x86");
    const arm64Device = this._architecture("generic_arm64");
    return html`
      <div
        class="options"
        role="group"
        aria-label=${localize(
          "views.minipc.architecture_selection_view.processor"
        )}
      >
        ${x86Device
          ? html`
              <option-card
                heading=${localize(
                  "views.minipc.architecture_selection_view.intel_amd_x86_64"
                )}
                description=${localize(
                  "views.minipc.architecture_selection_view.x86_64_description"
                )}
                icon="intel"
                .value=${x86Device.id}
                @click=${this._catalog.onPick}
              >
                <p class="option-examples">
                  ${localize(
                    "views.minipc.architecture_selection_view.x86_64_examples"
                  )}
                </p>
              </option-card>
            `
          : ""}
        ${arm64Device
          ? html`
              <option-card
                heading=${localize(
                  "views.minipc.architecture_selection_view.arm_aarch64"
                )}
                description=${localize(
                  "views.minipc.architecture_selection_view.arm64_description"
                )}
                icon="arm"
                .value=${arm64Device.id}
                @click=${this._catalog.onPick}
              >
                <p class="option-examples">
                  ${localize(
                    "views.minipc.architecture_selection_view.arm64_examples"
                  )}
                </p>
              </option-card>
            `
          : ""}
      </div>
      ${this._utmSupported
        ? html`<p class="mac-note">
            ${localizeContent(
              "views.minipc.architecture_selection_view.this_mac_note",
              {
                option: html`<strong
                  >${localize("common.virtual_machine")}</strong
                >`,
              }
            )}
          </p>`
        : ""}
    `;
  }

  private _architecture(category: DeviceCategory) {
    return this._catalog.devices.find((device) => device.category === category);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "minipc-architecture-selection-view": MiniPCArchitectureSelectionView;
  }
}
