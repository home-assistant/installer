import { css, html, type ReactiveControllerHost } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import "@home-assistant/webawesome/dist/components/input/input.js";
import "../components/vm-resources.js";
import type { VmResourceValues } from "../components/vm-resources.js";
import { localize } from "../localization/localize.js";
import {
  DEFAULT_CPU_CORES,
  DEFAULT_DISK_SIZE_GB,
  DEFAULT_MEMORY_MB,
  DISK_SIZE_OPTIONS_GB,
} from "../state/vm-defaults.js";
import type { WizardSelections } from "../state/wizard-state.js";
import { fieldError } from "./field-error.js";
import { mdiLabelOutline } from "./icons.js";

/** The name and resources a configure step saves for the VM */
export type VmSettingValues = Required<
  Pick<WizardSelections, "vmName" | "cpuCores" | "memoryMb" | "diskSizeGb">
>;

/** What the settings need from the step that shows them */
export interface VmSettingsOptions {
  /** The name on a first visit, also the field's placeholder */
  defaultName: string;
  /** Why the name can't be used, or undefined */
  nameError(name: string): string | undefined;
  /** What the name is for, shown below the field while it has no error */
  nameHint(): string;
  /** The longest name the field takes */
  maxNameLength?: number;
  /** Save the step's selections, which include these */
  save(): void;
}

/** The card the configure steps show their settings in */
export const configCardStyles = css`
  .config-card {
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
    padding: 1rem 1.25rem;
    background-color: var(--ha-card-background, #ffffff);
    border: 1px solid var(--ha-border-color, #e0e0e0);
    border-radius: var(--ha-card-border-radius, 12px);
    width: 100%;
    box-sizing: border-box;
    max-width: 500px;
  }
`;

/**
 * The VM's name, cores, memory and disk, as the UTM and Proxmox configure
 * steps offer them. They render into the step itself, with its
 * `settingStyles` and `fieldErrorStyles`, so the name's error stays the
 * step's own. Every change the user makes is saved through the step.
 */
export class VmSettings {
  private _values: VmSettingValues;

  constructor(
    private readonly _host: ReactiveControllerHost,
    private readonly _options: VmSettingsOptions
  ) {
    this._values = {
      vmName: _options.defaultName,
      cpuCores: DEFAULT_CPU_CORES,
      memoryMb: DEFAULT_MEMORY_MB,
      diskSizeGb: DEFAULT_DISK_SIZE_GB,
    };
  }

  get cpuCores(): number {
    return this._values.cpuCores;
  }

  get memoryMb(): number {
    return this._values.memoryMb;
  }

  /** What the step saves of these */
  get selections(): VmSettingValues {
    return { ...this._values };
  }

  get nameError(): string | undefined {
    return this._options.nameError(this._values.vmName);
  }

  /**
   * Start from what is already in the wizard state, so stepping back to an
   * earlier step and forward again keeps the user's settings. The defaults
   * only apply on the first visit.
   */
  restore(selections: WizardSelections) {
    this.set({
      vmName: selections.vmName ?? this._options.defaultName,
      cpuCores: selections.cpuCores ?? DEFAULT_CPU_CORES,
      memoryMb: selections.memoryMb ?? DEFAULT_MEMORY_MB,
      diskSizeGb: selections.diskSizeGb ?? DEFAULT_DISK_SIZE_GB,
    });
  }

  /** Change values without saving, like fitting them to what is offered */
  set(values: Partial<VmSettingValues>) {
    this._values = { ...this._values, ...values };
    this._host.requestUpdate();
  }

  // Arrow functions: Lit calls listeners on the step, not on this object
  private readonly _onNameInput = (e: Event) => {
    // Kept as typed. Falling back to the default here wrote it back into a
    // cleared field, in front of whatever was typed next, and rewriting the
    // field while typing didn't always reach it, so it could show another
    // name than the one used. nameError holds Next back instead.
    this.set({ vmName: (e.target as WaInput).value ?? "" });
    this._options.save();
  };

  private readonly _onResourcesChange = (e: CustomEvent<VmResourceValues>) => {
    const { cpuCores, memoryMb, diskSizeGb } = e.detail;
    this.set({ cpuCores, memoryMb, diskSizeGb });
    this._options.save();
  };

  /** The name field, in a setting row */
  renderName() {
    const error = this.nameError;
    return html`<div class="setting-row">
      <div class="setting-icon">
        <svg viewBox="0 0 24 24"><path d=${mdiLabelOutline} /></svg>
      </div>
      <div class="setting-content">
        <wa-input
          label=${localize("common.vm.display_name")}
          type="text"
          size="s"
          required
          .value=${this._values.vmName}
          @input=${this._onNameInput}
          placeholder=${this._options.defaultName}
          maxlength=${ifDefined(this._options.maxNameLength)}
          ${fieldError(error)}
        >
          <!-- In the hint slot, so the field describes itself with it.
            Not role="alert": ViewAccessibility focuses a new alert, which
            would pull focus out of the field halfway through typing -->
          <span slot="hint" class="name-hint" aria-live="polite"
            >${error ?? this._options.nameHint()}</span
          >
        </wa-input>
      </div>
    </div>`;
  }

  /**
   * The cores, memory and disk sliders. Pass the same option arrays until
   * the options change: new ones render every slider again.
   */
  renderResources(coreOptions: number[], memoryOptions: number[]) {
    return html`<vm-resources
      .coreOptions=${coreOptions}
      .memoryOptions=${memoryOptions}
      .diskOptions=${DISK_SIZE_OPTIONS_GB}
      .cpuCores=${this._values.cpuCores}
      .memoryMb=${this._values.memoryMb}
      .diskSizeGb=${this._values.diskSizeGb}
      @resources-change=${this._onResourcesChange}
    ></vm-resources>`;
  }
}
