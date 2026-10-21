import { localize } from "../../localization/localize.js";
import { linkStyles } from "../../utils/link-styles.js";
import { LitElement, html, css, nothing } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { customElement, state } from "lit/decorators.js";
import type { HaosConfig } from "../../api/index.js";
import { wizardState } from "../../state/wizard-state.js";
import {
  HA_HARDWARE,
  YELLOW_DEVICE_ID,
  haDeviceName,
  haHardwareName,
  installerConfig,
  isYellow,
  type HaHardware,
} from "./hardware.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import "../../components/device-card.js";
import "../../components/info-dialog.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";
import { loadStateStyles } from "../../utils/load-state.js";
import { DeviceCatalog, deviceGridStyles } from "../../utils/device-catalog.js";

/** A device on offer, with the storage config its write uses */
interface HardwareChoice {
  hardware: HaHardware;
  config: HaosConfig;
}

@customElement("ha-hardware-device-selection-view")
export class HaHardwareDeviceSelectionView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    loadStateStyles,
    reducedMotionStyles,
    linkStyles,
    deviceGridStyles,
    css`
      .reinstall-note {
        margin: 1rem 0 0 0;
        font-size: 0.9375rem;
        line-height: 1.6;
        color: var(--ha-text-color, #212121);
      }
    `,
  ];

  /**
   * Selectable hardware, each with the storage config its write uses. Both
   * Yellows share one card; the next step picks the compute module.
   */
  private readonly _catalog: DeviceCatalog<HardwareChoice> = new DeviceCatalog(
    this,
    this._accessibility,
    {
      // The Green and Yellow get a pinned installer. The Blue runs regular
      // HAOS, so it is only offered while the catalog still lists its board.
      offer: (manifest) =>
        HA_HARDWARE.flatMap((hardware) => {
          const config = hardware.installer
            ? installerConfig(hardware.installer)
            : manifest.devices.find(
                (device) => device.haos.board === hardware.manifestBoard
              )?.haos;
          return config ? [{ hardware, config }] : [];
        }),
      id: ({ hardware }) => hardware.deviceId,
      selections: ({ hardware, config }) => {
        const yellow = hardware.deviceId === YELLOW_DEVICE_ID;
        // A compute module picked before still names the Yellow and its board
        const keepModule =
          yellow && isYellow(wizardState.getState().selections.haHardware);
        return {
          deviceImage: hardware.image,
          // The Yellow's compute module is picked on a step of its own
          yellowModules: yellow ? this._yellowModules() : undefined,
          ...(!keepModule && {
            haHardware: yellow ? undefined : hardware.id,
            deviceName: haDeviceName(hardware),
            deviceConfig: yellow ? undefined : config,
          }),
        };
      },
      // The hardware, and a Yellow's compute modules, go with the device
      dependents: { haHardware: undefined, yellowModules: undefined },
      // Back from the module step, the catalog may offer other modules now
      refresh: ({ hardware }) => {
        if (hardware.deviceId === YELLOW_DEVICE_ID) {
          wizardState.setSelection("yellowModules", this._yellowModules());
        }
      },
    }
  );

  /** Settles the open reinstall question; unset while none is asked. */
  @state()
  private _confirmReinstall?: (confirmed: boolean) => void;

  disconnectedCallback() {
    super.disconnectedCallback();
    this._answerReinstall(false);
  }

  render() {
    return html`
      ${renderStepHeading(
        localize(
          "views.ha_hardware.device_selection_view.select_your_home_assistant_device"
        ),
        localize("views.ha_hardware.device_selection_view.subtitle")
      )}
      ${this._catalog.render(
        () => html`
          <wa-radio-group
            class="devices-grid"
            radio-tag="device-card"
            label=${localize("common.home_assistant_hardware")}
            .value=${this._catalog.selected ?? ""}
            @change=${this._catalog.onChange}
          >
            ${this._cards().map(
              (hardware) => html`
                <device-card
                  .value=${hardware.deviceId}
                  .name=${haDeviceName(hardware)}
                  .image=${hardware.image}
                ></device-card>
              `
            )}
          </wa-radio-group>

          ${this._renderReinstallDialog()}
        `
      )}
    `;
  }

  /** One card per device, so the Yellow shows once whatever its module. */
  private _cards(): HaHardware[] {
    return this._catalog.devices
      .map(({ hardware }) => hardware)
      .filter(
        (hardware, index, all) =>
          all.findIndex(({ deviceId }) => deviceId === hardware.deviceId) ===
          index
      );
  }

  private _renderReinstallDialog() {
    const hardware = HA_HARDWARE.find(
      ({ deviceId }) => deviceId === this._catalog.selected
    );
    if (!hardware) return nothing;
    // A Yellow kit may come without a compute module, so nothing is on it yet.
    // The others are ready to use, so going back is what most people want.
    const yellow = hardware.deviceId === YELLOW_DEVICE_ID;
    return html`
      <info-dialog
        ?open=${!!this._confirmReinstall}
        heading=${yellow
          ? localize(
              "views.ha_hardware.device_selection_view.yellow_may_be_ready"
            )
          : localize("views.ha_hardware.device_selection_view.ready_to_use", {
              device: haHardwareName(hardware.id),
            })}
        message=${yellow
          ? localize(
              "views.ha_hardware.device_selection_view.yellow_comes_installed"
            )
          : localize("views.ha_hardware.device_selection_view.comes_installed")}
        primary-label=${yellow
          ? localize("common.install")
          : localize("views.ha_hardware.device_selection_view.reinstall")}
        secondary-label=${localize("common.go_back")}
        emphasis=${yellow ? "primary" : "secondary"}
        @dialog-primary=${this._onReinstallConfirmed}
        @dialog-secondary=${this._onReinstallDeclined}
      >
        <p class="reinstall-note">
          ${yellow
            ? localize("views.ha_hardware.device_selection_view.yellow_install")
            : localize(
                "views.ha_hardware.device_selection_view.only_reinstall"
              )}
        </p>
      </info-dialog>
    `;
  }

  /**
   * Official hardware ships with Home Assistant installed, so before going on
   * ask whether the user really wants to reinstall. Resolves true to go on.
   */
  confirmReinstall(): Promise<boolean> {
    this._answerReinstall(false);
    return new Promise((resolve) => {
      this._confirmReinstall = resolve;
    });
  }

  private _onReinstallConfirmed() {
    this._answerReinstall(true);
  }

  private _onReinstallDeclined() {
    this._answerReinstall(false);
  }

  private _answerReinstall(confirmed: boolean) {
    const resolve = this._confirmReinstall;
    this._confirmReinstall = undefined;
    resolve?.(confirmed);
  }

  /** The Yellow's compute modules, for the step that picks one. */
  private _yellowModules() {
    return this._catalog.devices.flatMap(({ hardware: { id }, config }) =>
      isYellow(id) ? [{ id, config }] : []
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-hardware-device-selection-view": HaHardwareDeviceSelectionView;
  }
}
