import { localize } from "../../localization/localize.js";
import { LitElement, html } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { logFrontendError } from "../../utils/diagnostics.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState } from "../../state/wizard-state.js";
import { getSystemInfo } from "../../api/commands.js";
import type { SystemInfo } from "../../api/types.js";
import {
  DEFAULT_UTM_VM_NAME,
  isValidUtmVmName,
  memoryOptionsUpTo,
} from "../../state/vm-defaults.js";
import { settingStyles } from "../../utils/setting-styles.js";
import { fieldErrorStyles } from "../../utils/field-error.js";
import { VmSettings, configCardStyles } from "../../utils/vm-settings.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";

/**
 * The cores and memory to offer on this system: every even core count up to
 * its own, and its memory less 2 GB for the host. Without the system's
 * figures, those of an 8-core system with 16 GB.
 */
function resourceOptions(systemInfo: SystemInfo | null) {
  const maxCores = systemInfo?.cpu_cores || 8;
  const cores: number[] = [];
  for (let count = 2; count <= maxCores; count += 2) {
    cores.push(count);
  }
  const maxMemoryMb = systemInfo?.memory_mb || 16384;
  return {
    // Two at least, even on a system with one
    cores: cores.length ? cores : [2],
    memory: memoryOptionsUpTo(maxMemoryMb - 2048),
  };
}

@customElement("utm-configure-view")
export class UtmConfigureView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    settingStyles,
    fieldErrorStyles,
    configCardStyles,
  ];

  private readonly _vm = new VmSettings(this, {
    defaultName: DEFAULT_UTM_VM_NAME,
    nameError: (name) =>
      isValidUtmVmName(name)
        ? undefined
        : localize("views.utm.utm_configure_view.vm_name_required"),
    nameHint: () => localize("views.utm.utm_configure_view.vm_name_hint"),
    save: () => this._saveSelections(),
  });

  /** What the sliders offer, kept until the system lookup changes it */
  @state()
  private _options = resourceOptions(null);

  connectedCallback() {
    super.connectedCallback();
    this._vm.restore(wizardState.getState().selections);
    void this._loadSystemInfo();
  }

  private async _loadSystemInfo() {
    try {
      const systemInfo = await getSystemInfo();

      // The user may have left this step while the lookup was in flight;
      // saving now would write over what the next step reads
      if (!this.isConnected) return;

      this._options = resourceOptions(systemInfo);

      // Cap the selected values to what this system can offer
      const { cores, memory } = this._options;
      if (!cores.includes(this._vm.cpuCores)) {
        this._vm.set({ cpuCores: cores[cores.length - 1] || 2 });
      }
      if (!memory.includes(this._vm.memoryMb)) {
        this._vm.set({ memoryMb: memory[memory.length - 1] || 2048 });
      }

      this._saveSelections();
    } catch (error) {
      logFrontendError(error);
      // Keep the restored values (or defaults), unless this step was left
      // while the lookup was in flight
      if (this.isConnected) {
        this._saveSelections();
      }
    }
  }

  private _saveSelections() {
    wizardState.setSelections(this._vm.selections);
  }

  render() {
    return html`
      ${renderStepHeading(
        localize("common.vm.configure_virtual_machine"),
        localize("views.utm.utm_configure_view.subtitle")
      )}

      <div class="config-card">
        ${this._vm.renderName()}
        ${this._vm.renderResources(this._options.cores, this._options.memory)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "utm-configure-view": UtmConfigureView;
  }
}
