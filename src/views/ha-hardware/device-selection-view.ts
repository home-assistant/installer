import { localize } from "../../localization/localize.js";
import {
  installerError,
  type InstallerError,
} from "../../utils/installer-error.js";
import { linkStyles } from "../../utils/link-styles.js";
import { LitElement, html, css, nothing } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { InstallDiagnostics } from "../../utils/diagnostics.js";
import { customElement, query, state } from "lit/decorators.js";
import { getManifest, type HaosConfig } from "../../api/index.js";
import { wizardState } from "../../state/wizard-state.js";
import {
  HA_HARDWARE,
  haHardwareName,
  installerConfig,
  type HaHardware,
} from "./hardware.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import { clearDriveSelection } from "../../utils/drive-selection.js";
import "../../components/device-card.js";
import "../../components/info-dialog.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";
import {
  loadStateStyles,
  renderLoadError,
  renderLoading,
} from "../../utils/load-state.js";

@customElement("ha-hardware-device-selection-view")
export class HaHardwareDeviceSelectionView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    loadStateStyles,
    reducedMotionStyles,
    linkStyles,
    css`
      .devices-grid {
        width: 100%;
        max-width: 700px;
      }

      /* The group's default layout is a flex column; the tiles want a grid. */
      .devices-grid::part(form-control-input) {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 1.5rem;
      }
      .reinstall-note {
        margin: 1rem 0 0 0;
        font-size: 0.9375rem;
        line-height: 1.6;
        color: var(--ha-text-color, #212121);
      }

      .hint {
        max-width: 600px;
        margin: 1.5rem 0 0 0;
        font-size: 0.875rem;
        color: var(--ha-secondary-text-color, #727272);
        text-align: center;
      }
    `,
  ];

  /** Selectable hardware, each with the storage config its write uses. */
  @state()
  private _devices: { hardware: HaHardware; config: HaosConfig }[] = [];

  @state()
  private _loading = true;

  @state()
  private _error: InstallerError | null = null;

  /** Try again while an error offers it, else the heading of the list */
  @query(".error wa-button, h2")
  private _continueFrom?: HTMLElement;

  @state()
  private _selectedDeviceId: string | null = null;

  /** Settles the open reinstall question; unset while none is asked. */
  @state()
  private _confirmReinstall?: (confirmed: boolean) => void;

  disconnectedCallback() {
    super.disconnectedCallback();
    this._answerReinstall(false);
  }

  connectedCallback() {
    super.connectedCallback();
    void this._loadDevices();

    // Check if there's already a selection in wizard state
    const state = wizardState.getState();
    if (state.selections.device) {
      this._selectedDeviceId = state.selections.device;
    }
  }

  private async _loadDevices() {
    // An error stays, with Try again busy, until this result replaces it
    this._loading = true;
    if (wizardState.getState().selections.deviceCatalogReady) {
      wizardState.setSelection("deviceCatalogReady", false);
    }

    try {
      const manifest = await getManifest();
      if (!this.isConnected) return;
      // The Green and Yellow get a pinned installer. The Blue runs regular
      // HAOS, so it is only offered while the catalog still lists its board.
      this._devices = HA_HARDWARE.flatMap((hardware) => {
        const config = hardware.installer
          ? installerConfig(hardware.installer)
          : manifest.devices.find(
              (device) => device.haos.board === hardware.manifestBoard
            )?.haos;
        return config ? [{ hardware, config }] : [];
      });
      if (
        !this._devices.some(
          ({ hardware }) => hardware.deviceId === this._selectedDeviceId
        )
      ) {
        this._selectedDeviceId = null;
        wizardState.setSelections({
          device: undefined,
          deviceConfig: undefined,
          haHardware: undefined,
        });
      }
      this._error = null;
      wizardState.setSelection("deviceCatalogReady", true);
    } catch (err) {
      if (!this.isConnected) return;
      new InstallDiagnostics("flash").fail(err);
      this._error = installerError(
        err,
        localize("common.failed_to_load_devices")
      );
    } finally {
      this._loading = false;
    }
    // The list can take the place of Try again, which had the focus
    await this.updateComplete;
    this._accessibility.restoreFocus(this._continueFrom);
  }

  render() {
    if (this._error) {
      return renderLoadError(this._error, this._loading, () =>
        this._loadDevices()
      );
    }

    if (this._loading) {
      return renderLoading(localize("common.loading_devices"));
    }

    return html`
      ${renderStepHeading(
        localize(
          "views.ha_hardware.device_selection_view.select_your_home_assistant_device"
        ),
        localize("views.ha_hardware.device_selection_view.subtitle")
      )}

      <wa-radio-group
        class="devices-grid"
        radio-tag="device-card"
        aria-label=${localize("common.home_assistant_hardware")}
        .value=${this._selectedDeviceId ?? ""}
        @change=${this._onDeviceChange}
      >
        ${this._devices.map(
          ({ hardware }) => html`
            <device-card
              .value=${hardware.deviceId}
              .name=${haHardwareName(hardware.id)}
              .image=${hardware.image}
            ></device-card>
          `
        )}
      </wa-radio-group>

      <p class="hint">
        ${localize(
          "views.ha_hardware.device_selection_view.yellow_compute_module_hint"
        )}
      </p>

      ${this._renderReinstallDialog()}
    `;
  }

  private _renderReinstallDialog() {
    const hardware = HA_HARDWARE.find(
      ({ deviceId }) => deviceId === this._selectedDeviceId
    );
    if (!hardware) return nothing;
    // A Yellow kit may come without a compute module, so nothing is on it yet.
    // The others are ready to use, so going back is what most people want.
    const yellow = hardware.id === "yellow-cm4" || hardware.id === "yellow-cm5";
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

  private _onDeviceChange(e: Event) {
    const id = (e.target as { value?: string | number | null }).value;
    const device = this._devices.find(
      ({ hardware }) => hardware.deviceId === id
    );
    if (device) {
      this._onSelectDevice(device.hardware, device.config);
    }
  }

  private _onSelectDevice(hardware: HaHardware, config: HaosConfig) {
    // Each device is prepared differently and written to a different drive,
    // so any change of device, including after a catalog refresh cleared the
    // previous one, must not keep the old drive.
    const previous = wizardState.getState().selections.haHardware;
    this._selectedDeviceId = hardware.deviceId;
    wizardState.setSelections({
      device: hardware.deviceId,
      haHardware: hardware.id,
      deviceName: haHardwareName(hardware.id),
      deviceImage: hardware.image,
      deviceConfig: config,
    });
    if (previous !== hardware.id) clearDriveSelection();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-hardware-device-selection-view": HaHardwareDeviceSelectionView;
  }
}
