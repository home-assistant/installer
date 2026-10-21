import { css, type LitElement, type ReactiveController } from "lit";
import type WaRadioGroup from "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import { getManifest, type Device, type DeviceManifest } from "../api/index.js";
import { localize } from "../localization/localize.js";
import { wizardState, type WizardSelections } from "../state/wizard-state.js";
import { InstallDiagnostics } from "./diagnostics.js";
import { clearDriveSelection } from "./drive-selection.js";
import { installerError, type InstallerError } from "./installer-error.js";
import { renderLoadError, renderLoading } from "./load-state.js";
import type { ViewAccessibility } from "./view-accessibility.js";

export interface DeviceCatalogOptions<T> {
  /** The devices the step offers out of the catalog */
  offer(manifest: DeviceManifest): T[];
  /** The id the wizard keeps for a device */
  id(device: T): string;
  /** What the wizard keeps for a device once it is chosen, besides its id */
  selections(device: T): Partial<WizardSelections>;
  /** What the step says it waits for; devices, unless it says otherwise */
  loadingLabel?(): string;
  /** Why the step is empty when the error itself doesn't say */
  failedMessage?(): string;
  /** More to clear when the catalog no longer offers the device chosen */
  dependents?: Partial<WizardSelections>;
  /** Hand on what a fresh catalog has for the device chosen before */
  refresh?(device: T): void;
}

/**
 * The catalog's devices a picker step offers, and the one chosen. The step
 * loads the catalog each time it shows, and Next waits until it has, so a
 * device the catalog no longer offers is dropped before anyone goes on.
 */
export class DeviceCatalog<T> implements ReactiveController {
  devices: T[] = [];
  /** The id of the device chosen, while the catalog offers it */
  selected: string | null = null;
  loading = true;
  error: InstallerError | null = null;

  constructor(
    private readonly host: LitElement,
    private readonly accessibility: ViewAccessibility,
    private readonly options: DeviceCatalogOptions<T>
  ) {
    host.addController(this);
  }

  hostConnected() {
    this.selected = wizardState.getState().selections.device ?? null;
    void this.load();
  }

  async load() {
    // An error stays, with Try again busy, until this result replaces it
    this.loading = true;
    this.host.requestUpdate();
    if (wizardState.getState().selections.deviceCatalogReady) {
      wizardState.setSelection("deviceCatalogReady", false);
    }

    try {
      const manifest = await getManifest();
      if (!this.host.isConnected) return;
      this.devices = this.options.offer(manifest);
      const chosen = this._find(this.selected);
      if (chosen) {
        this.options.refresh?.(chosen);
      } else {
        this.selected = null;
        wizardState.setSelections({
          device: undefined,
          deviceConfig: undefined,
          ...this.options.dependents,
        });
      }
      this.error = null;
      wizardState.setSelection("deviceCatalogReady", true);
    } catch (err) {
      if (!this.host.isConnected) return;
      new InstallDiagnostics("flash").fail(err);
      this.error = installerError(
        err,
        this.options.failedMessage?.() ??
          localize("common.failed_to_load_devices")
      );
    } finally {
      this.loading = false;
      this.host.requestUpdate();
    }
    // The list can take the place of Try again, which had the focus
    await this.host.updateComplete;
    this.accessibility.restoreFocus(this._continueFrom());
  }

  /**
   * The step's choices once the catalog is in; until then what it waits for,
   * or why it failed. The step's heading stays above either.
   */
  render(choices: () => unknown) {
    if (this.error) {
      return renderLoadError(this.error, this.loading, () => this.load());
    }
    if (this.loading) {
      return renderLoading(
        this.options.loadingLabel?.() ?? localize("common.loading_devices")
      );
    }
    return choices();
  }

  /** For the change event of the step's radio group */
  readonly onChange = (e: Event) => {
    const device = this._find((e.target as WaRadioGroup).value);
    if (device) this.choose(device);
  };

  /**
   * Choose `device`. A drive is picked for one device, and the drive step
   * checks it against that device's storage, so another device drops it.
   * The drive step would otherwise drop a drive too small for the new
   * device as if it had been unplugged.
   */
  choose(device: T) {
    const previous = wizardState.getState().selections.device;
    this.selected = this.options.id(device);
    wizardState.setSelections({
      ...this.options.selections(device),
      device: this.selected,
    });
    if (previous !== this.selected) clearDriveSelection();
    this.host.requestUpdate();
  }

  private _find(id: unknown): T | undefined {
    return this.devices.find((device) => this.options.id(device) === id);
  }

  /** Try again while an error offers it, else the step's heading */
  private _continueFrom() {
    const root = this.host.renderRoot;
    return (
      root.querySelector<HTMLElement>(".error wa-button") ??
      root.querySelector<HTMLElement>("h2")
    );
  }
}

/** What the wizard keeps for a device straight from the catalog. */
export function deviceSelections(device: Device): Partial<WizardSelections> {
  return {
    deviceName: device.name,
    deviceImage: device.image_url || "",
    deviceConfig: device.haos,
  };
}

/** Device cards in a radio group, as a grid of tiles. */
export const deviceGridStyles = css`
  .devices-grid {
    width: 100%;
    max-width: 700px;
  }

  /* Named by its label, which the step's heading already shows */
  .devices-grid::part(form-control-label) {
    display: none;
  }

  /* The group's default layout is a flex column. Empty columns collapse, so
     a short row of devices still spans the width. */
  .devices-grid::part(form-control-input) {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1rem;
  }
`;
