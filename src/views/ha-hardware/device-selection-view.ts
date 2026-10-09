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
import { getManifest, type Device } from "../../api/index.js";
import { wizardState } from "../../state/wizard-state.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
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

    .info-box {
      max-width: 600px;
      padding: 1rem;
      margin-top: 2rem;
      background-color: var(--ha-card-background, #f5f5f5);
      border-radius: 8px;
      font-size: 0.875rem;
      color: var(--ha-secondary-text-color, #727272);
      text-align: center;
    }

    @media (prefers-color-scheme: dark) {
      .info-box {
        background-color: rgba(255, 255, 255, 0.05);
      }
    }
  `;

  @state()
  private _devices: Device[] = [];

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
      this._selectedDeviceId = state.selections.device as string;
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
      // Filter to only show Home Assistant Hardware devices
      this._devices = manifest.devices.filter(
        (device) => device.category === "home_assistant_hardware"
      );
      if (
        !this._devices.some((device) => device.id === this._selectedDeviceId)
      ) {
        this._selectedDeviceId = null;
        wizardState.setSelection("device", undefined);
        wizardState.setSelection("deviceConfig", undefined);
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
          (device) => html`
            <device-card
              .value=${device.id}
              .name=${device.name}
              .image=${device.image_url || ""}
            ></device-card>
          `
        )}
      </wa-radio-group>

      <div class="info-box">
        ${localize(
          "views.ha_hardware.device_selection_view.connect_your_device_to_this_computer_using_a_usb_cable_or_adapter_you_ll_fl"
        )}
      </div>
    `;
  }

  private _onDeviceChange(e: Event) {
    const id = (e.target as { value?: string | number | null }).value;
    const device = this._devices.find((d) => d.id === id);
    if (device) {
      this._onSelectDevice(device);
    }
  }

  private _onSelectDevice(device: Device) {
    this._selectedDeviceId = device.id;
    wizardState.setSelection("device", device.id);
    wizardState.setSelection("deviceName", device.name);
    wizardState.setSelection("deviceImage", device.image_url || "");
    wizardState.setSelection("deviceConfig", device.haos);

    this.dispatchEvent(
      new CustomEvent("device-selected", {
        detail: { device },
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
