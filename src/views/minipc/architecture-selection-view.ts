import { localize, localizeContent } from "../../localization/localize.js";
import { linkStyles } from "../../utils/link-styles.js";
import { LitElement, html, css, nothing } from "lit";
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
import "@home-assistant/webawesome/dist/components/button/button.js";
import "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import "@home-assistant/webawesome/dist/components/radio/radio.js";
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
        color: var(--ha-secondary-text-color, #727272);
        margin: 1rem 0 2rem 0;
        text-align: center;
        max-width: 500px;
      }

      .option-content {
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      .option-description {
        margin: 0 0 0.75rem 0;
      }

      .option-examples {
        font-size: 0.8125rem;
        color: var(--ha-control-secondary-text-color, #686868);
        margin: 0;
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
      <wa-radio-group
        class="options"
        orientation="horizontal"
        label=${localize("views.minipc.architecture_selection_view.processor")}
        .value=${this._catalog.selected ?? ""}
        @change=${this._catalog.onChange}
      >
        ${x86Device
          ? html`
              <wa-radio appearance="button" .value=${x86Device.id}>
                <div class="option-icon">
                  <svg viewBox="0 0 24 24">
                    <path
                      d="M20.42 7.345v9.18h1.651v-9.18zM0 7.475v1.737h1.737V7.474zm9.78.352v6.053c0 .513.044.945.13 1.292.087.34.235.618.44.828.203.21.475.359.803.451.334.093.754.136 1.255.136h.216v-1.533c-.24 0-.445-.012-.593-.037a.672.672 0 0 1-.39-.173.693.693 0 0 1-.173-.377 4.002 4.002 0 0 1-.037-.606v-2.182h1.193v-1.416h-1.193V7.827zm-3.505 2.312c-.396 0-.76.08-1.082.241-.327.161-.6.384-.822.668l-.087.117v-.902H2.658v6.256h1.639v-3.214c.018-.588.16-1.02.433-1.299.29-.297.642-.445 1.044-.445.476 0 .841.149 1.082.433.235.284.359.686.359 1.2v3.324h1.663V12.97c.006-.89-.229-1.595-.686-2.09-.458-.495-1.1-.742-1.917-.742zm10.065.006a3.252 3.252 0 0 0-2.306.946c-.29.29-.525.637-.692 1.033a3.145 3.145 0 0 0-.254 1.273c0 .452.08.878.241 1.274.161.395.39.742.674 1.032.284.29.637.526 1.045.693.408.173.86.26 1.342.26 1.397 0 2.262-.637 2.782-1.23l-1.187-.904c-.248.297-.841.699-1.583.699-.464 0-.847-.105-1.138-.321a1.588 1.588 0 0 1-.593-.872l-.019-.056h4.915v-.587c0-.451-.08-.872-.235-1.267a3.393 3.393 0 0 0-.661-1.033 3.013 3.013 0 0 0-1.02-.692 3.345 3.345 0 0 0-1.311-.248zm-16.297.118v6.256h1.651v-6.256zm16.278 1.286c1.132 0 1.664.797 1.664 1.255l-3.32.006c0-.458.525-1.255 1.656-1.261zm7.073 3.814a.606.606 0 0 0-.606.606.606.606 0 0 0 .606.606.606.606 0 0 0 .606-.606.606.606 0 0 0-.606-.606zm-.008.105a.5.5 0 0 1 .002 0 .5.5 0 0 1 .5.501.5.5 0 0 1-.5.5.5.5 0 0 1-.5-.5.5.5 0 0 1 .498-.5zm-.233.155v.699h.13v-.285h.093l.173.285h.136l-.18-.297a.191.191 0 0 0 .118-.056c.03-.03.05-.074.05-.136 0-.068-.02-.117-.063-.154-.037-.038-.105-.056-.185-.056zm.13.099h.154c.019 0 .037.006.056.012a.064.064 0 0 1 .037.031c.013.013.012.031.012.056a.124.124 0 0 1-.012.055.164.164 0 0 1-.037.031c-.019.006-.037.013-.056.013h-.154Z"
                    />
                  </svg>
                </div>
                <div class="option-content">
                  <p class="option-title">
                    ${localize(
                      "views.minipc.architecture_selection_view.intel_amd_x86_64"
                    )}
                  </p>
                  <p class="option-description">
                    ${localize(
                      "views.minipc.architecture_selection_view.x86_64_description"
                    )}
                  </p>
                  <p class="option-examples">
                    ${localize(
                      "views.minipc.architecture_selection_view.x86_64_examples"
                    )}
                  </p>
                </div>
                ${this._renderCheck(x86Device)}
              </wa-radio>
            `
          : ""}
        ${arm64Device
          ? html`
              <wa-radio appearance="button" .value=${arm64Device.id}>
                <div class="option-icon">
                  <svg viewBox="0 0 24 24">
                    <path
                      d="M5.419 8.534h1.614v6.911H5.419v-.72c-.71.822-1.573.933-2.07.933C1.218 15.658 0 13.882 0 11.985c0-2.253 1.542-3.633 3.37-3.633.507 0 1.4.132 2.049.984zm-3.765 3.491c0 1.198.751 2.202 1.918 2.202 1.015 0 1.959-.74 1.959-2.181 0-1.512-.934-2.233-1.959-2.233-1.167-.01-1.918.974-1.918 2.212zm7.297-3.49h1.613v.618a3 3 0 0 1 .67-.578c.314-.183.619-.233.984-.233.396 0 .822.06 1.269.324l-.66 1.462a1.432 1.432 0 0 0-.822-.244c-.345 0-.69.05-1.005.376-.446.477-.446 1.136-.446 1.593v3.582H8.94zm5.56 0h1.614v.639c.538-.66 1.177-.822 1.705-.822.72 0 1.4.345 1.786 1.015.579-.822 1.441-1.015 2.05-1.015.842 0 1.573.396 1.969 1.086.132.233.365.74.365 1.745v4.272h-1.614V11.65c0-.771-.08-1.086-.152-1.228-.101-.264-.345-.609-.923-.609-.396 0-.741.213-.954.508-.284.395-.315.984-.315 1.572v3.562H18.43V11.65c0-.771-.081-1.086-.152-1.228-.102-.264-.345-.609-.924-.609-.396 0-.74.213-.954.508-.284.395-.314.984-.314 1.572v3.562h-1.573"
                    />
                  </svg>
                </div>
                <div class="option-content">
                  <p class="option-title">
                    ${localize(
                      "views.minipc.architecture_selection_view.arm_aarch64"
                    )}
                  </p>
                  <p class="option-description">
                    ${localize(
                      "views.minipc.architecture_selection_view.arm64_description"
                    )}
                  </p>
                  <p class="option-examples">
                    ${localize(
                      "views.minipc.architecture_selection_view.arm64_examples"
                    )}
                  </p>
                </div>
                ${this._renderCheck(arm64Device)}
              </wa-radio>
            `
          : ""}
      </wa-radio-group>
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

  // Screen readers already hear which radio is checked
  private _renderCheck(device: Device) {
    return device.id === this._catalog.selected
      ? html`<span class="selected-indicator" aria-hidden="true">✓</span>`
      : nothing;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "minipc-architecture-selection-view": MiniPCArchitectureSelectionView;
  }
}
