import { localize } from "../../localization/localize.js";
import { LitElement, html } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { logFrontendError } from "../../utils/diagnostics.js";
import { customElement, query, state } from "lit/decorators.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import { wizardState } from "../../state/wizard-state.js";
import { getSystemInfo, utmVmNameTaken } from "../../api/commands.js";
import type { SystemInfo } from "../../api/types.js";
import {
  DEFAULT_UTM_VM_NAME,
  isValidUtmVmName,
  memoryOptionsUpTo,
  utmVmConfig,
} from "../../state/vm-defaults.js";
import { installerError } from "../../utils/installer-error.js";
import "../../components/inline-notice.js";
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
    nameError: (name) => {
      if (!isValidUtmVmName(name)) {
        return localize("views.utm.utm_configure_view.vm_name_required");
      }
      return name === this._takenName
        ? localize("views.utm.utm_configure_view.vm_name_taken", { name })
        : undefined;
    },
    nameHint: () => localize("views.utm.utm_configure_view.vm_name_hint"),
    save: () => this._saveSelections(),
  });

  /** What the sliders offer, kept until the system lookup changes it */
  @state()
  private _options = resourceOptions(null);

  /** A name UTM already has, as the check at Next found */
  @state() private _takenName?: string;
  /** Why the check at Next could not ask UTM */
  @state() private _checkProblem = "";

  /** In the name's field, which the shared VM settings render */
  @query(".name-hint") private _nameHint?: HTMLElement;

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

  /**
   * Ask UTM whether it has a VM of this name already. Resolves false if it
   * has, if UTM can't say, or if the settings changed or the step was left
   * while UTM answered.
   */
  async check(): Promise<boolean> {
    const selections = wizardState.getState().selections;
    // The install goes on with the VM it made or is making, under this name
    if (selections.vmId || selections.utmCreation) return true;
    const { name } = utmVmConfig(selections);
    const isCurrent = () =>
      this.isConnected && wizardState.getState().selections === selections;
    try {
      const taken = await utmVmNameTaken(name);
      if (!isCurrent()) return false;
      this._checkProblem = "";
      if (!taken) return true;
      this._takenName = name;
      await this.updateComplete;
      // Once the field has its error, so it is read out with it
      const field = this._nameHint?.closest<WaInput>("wa-input");
      await field?.updateComplete;
      field?.focus();
      return false;
    } catch (error) {
      if (isCurrent()) this._checkProblem = installerError(error).message;
      return false;
    }
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

      ${this._checkProblem
        ? html`<inline-notice variant="error" data-focus-alert>
            <p>${this._checkProblem}</p>
          </inline-notice>`
        : ""}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "utm-configure-view": UtmConfigureView;
  }
}
