import { localize } from "../../localization/localize.js";
import {
  installerError,
  renderErrorHelp,
  type InstallerError,
} from "../../utils/installer-error.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { InstallDiagnostics } from "../../utils/diagnostics.js";
import { customElement, state } from "lit/decorators.js";
import { getManifest, type HaosConfig } from "../../api/index.js";
import { wizardState } from "../../state/wizard-state.js";
import {
  HA_HARDWARE,
  findHaHardware,
  haHardwareName,
  installerConfig,
  type HaHardware,
} from "./hardware.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import { clearDriveSelection } from "../../utils/drive-selection.js";
import "../../components/device-card.js";

@customElement("ha-hardware-device-selection-view")
export class HaHardwareDeviceSelectionView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = css`
    ${reducedMotionStyles}
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
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
    }

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

    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 3rem;
      color: var(--ha-secondary-text-color, #727272);
    }

    .loading-spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--ha-border-color, #e0e0e0);
      border-top-color: var(--ha-primary-color, #03a9f4);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 1rem;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .error {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem;
      text-align: center;
    }

    .error-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
    }

    .error-message {
      color: var(--ha-error-color, #db4437);
      margin-bottom: 1rem;
    }

    .hint {
      max-width: 600px;
      margin: 1.5rem 0 0 0;
      font-size: 0.875rem;
      color: var(--ha-secondary-text-color, #727272);
      text-align: center;
    }
  `;

  /** Selectable hardware, each with the storage config its write uses. */
  @state()
  private _devices: { hardware: HaHardware; config: HaosConfig }[] = [];

  @state()
  private _loading = true;

  @state()
  private _error: InstallerError | null = null;

  @state()
  private _selectedDeviceId: string | null = null;

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
    this._loading = true;
    this._error = null;
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
        wizardState.setSelection("device", undefined);
        wizardState.setSelection("deviceConfig", undefined);
        wizardState.setSelection("haHardware", undefined);
      }
      wizardState.setSelection("deviceCatalogReady", true);
    } catch (err) {
      if (this.isConnected) new InstallDiagnostics("flash").fail(err);
      this._error = installerError(
        err,
        localize(
          "views.ha_hardware.device_selection_view.failed_to_load_devices"
        )
      );
    } finally {
      this._loading = false;
    }
  }

  render() {
    if (this._loading) {
      return html`
        <div class="loading">
          <div class="loading-spinner"></div>
          <span
            >${localize(
              "views.ha_hardware.device_selection_view.loading_devices"
            )}</span
          >
        </div>
      `;
    }

    if (this._error) {
      return html`
        <div class="error">
          <span class="error-icon">⚠️</span>
          <p
            class="error-message"
            role="alert"
            style="overflow-wrap: anywhere;"
          >
            ${this._error?.message}
          </p>
          ${renderErrorHelp()}
          ${this._error.retryable
            ? html`<wa-button
                variant="brand"
                appearance="outlined"
                @click=${this._loadDevices}
              >
                ${localize("components.app_shell.try_again")}
              </wa-button>`
            : ""}
        </div>
      `;
    }

    return html`
      <h2>
        ${localize(
          "views.ha_hardware.device_selection_view.select_your_home_assistant_device"
        )}
      </h2>
      <p class="subtitle">
        ${localize(
          "views.ha_hardware.device_selection_view.choose_your_official_home_assistant_hardware_by_nabu_casa"
        )}
      </p>

      <wa-radio-group
        class="devices-grid"
        radio-tag="device-card"
        aria-label=${localize("components.app_shell.home_assistant_hardware")}
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
    `;
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
    // A Yellow with a CM4 and one with a CM5 write the same image to
    // different drives, so a switch must not keep the old drive.
    const previous = findHaHardware(
      wizardState.getState().selections.haHardware
    );
    this._selectedDeviceId = hardware.deviceId;
    wizardState.setSelection("device", hardware.deviceId);
    wizardState.setSelection("haHardware", hardware.id);
    wizardState.setSelection("deviceName", haHardwareName(hardware.id));
    wizardState.setSelection("deviceImage", hardware.image);
    wizardState.setSelection("deviceConfig", config);
    if (previous && previous.id !== hardware.id) clearDriveSelection();

    this.dispatchEvent(
      new CustomEvent("device-selected", {
        detail: { hardware },
        bubbles: true,
        composed: true,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-hardware-device-selection-view": HaHardwareDeviceSelectionView;
  }
}
