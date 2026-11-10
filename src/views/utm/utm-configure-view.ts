import { localize } from "../../localization/localize.js";
import { LitElement, css, html } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { logFrontendError, recordFailure } from "../../utils/diagnostics.js";
import { customElement, query, state } from "lit/decorators.js";
import { wizardState } from "../../state/wizard-state.js";
import { checkUtmVmName, getSystemInfo } from "../../api/commands.js";
import type { SystemInfo } from "../../api/types.js";
import {
  installerError,
  type InstallerError,
} from "../../utils/installer-error.js";
import {
  DEFAULT_UTM_VM_NAME,
  isValidUtmVmName,
  memoryOptionsUpTo,
  utmVmConfig,
} from "../../state/vm-defaults.js";
import { settingStyles } from "../../utils/setting-styles.js";
import { fieldErrorStyles } from "../../utils/field-error.js";
import { VmSettings, configCardStyles } from "../../utils/vm-settings.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";

/** What the check at Next answers for a name UTM already has */
const NAME_TAKEN = "utm_vm_name_taken";

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
    css`
      .error-text {
        width: 100%;
        max-width: var(--ha-content-width);
        margin: 1rem 0 0;
        font-size: 0.875rem;
        color: var(--ha-error-color);
        overflow-wrap: anywhere;
      }
    `,
  ];

  private readonly _vm = new VmSettings(this, {
    defaultName: DEFAULT_UTM_VM_NAME,
    // A name UTM already has shows here once the check at Next found it
    nameError: (name) =>
      isValidUtmVmName(name)
        ? this._checkError?.code === NAME_TAKEN
          ? this._checkError.message
          : undefined
        : localize("views.utm.utm_configure_view.vm_name_required"),
    nameHint: () => localize("views.utm.utm_configure_view.vm_name_hint"),
    save: () => this._saveSelections(),
  });

  /** What the sliders offer, kept until the system lookup changes it */
  @state()
  private _options = resourceOptions(null);

  /**
   * Why the check at Next refused the settings, until one of them changes.
   * A taken name shows at the name, anything else below the settings.
   */
  @state()
  private _checkError: InstallerError | null = null;

  @query("wa-input") private _nameInput?: HTMLElement & {
    updateComplete?: Promise<unknown>;
  };

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
    // Next checks the changed settings again
    this._checkError = null;
    wizardState.setSelections(this._vm.selections);
  }

  /**
   * Ask UTM whether it already has a VM by the chosen name, which it would
   * only refuse once the image is downloaded. Resolves false if it has, if
   * UTM couldn't say, or if the settings changed or the step was left while
   * UTM answered.
   */
  async check(): Promise<boolean> {
    const selections = wizardState.getState().selections;
    const isCurrent = () =>
      this.isConnected && wizardState.getState().selections === selections;

    // The previous answer stays until this one arrives: removing it would
    // move the focus on every press of Next
    try {
      await checkUtmVmName(utmVmConfig(selections).name);
      if (!isCurrent()) return false;
      this._checkError = null;
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      recordFailure("utm", error);
      const checkError = installerError(error);
      this._checkError = checkError;
      if (checkError.code === NAME_TAKEN) await this._focusName(checkError);
      return false;
    }
  }

  /** The name field, which says why its name can't be used */
  private async _focusName(error: InstallerError) {
    await this.updateComplete;
    if (!this.isConnected || this._checkError !== error) return;
    // Once the field shows the error, so it is read out with it
    await this._nameInput?.updateComplete;
    this._nameInput?.focus();
  }

  render() {
    // What the check refused that is not about the name, like UTM not
    // answering
    const checkError = this._checkError;
    const generalError =
      checkError && checkError.code !== NAME_TAKEN ? checkError : null;
    return html`
      ${renderStepHeading(
        localize("common.vm.configure_virtual_machine"),
        localize("views.utm.utm_configure_view.subtitle")
      )}

      <div class="config-card">
        ${this._vm.renderName()}
        ${this._vm.renderResources(this._options.cores, this._options.memory)}
      </div>
      ${generalError
        ? html`<p class="error-text" data-focus-alert>
            ${generalError.message}
          </p>`
        : ""}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "utm-configure-view": UtmConfigureView;
  }
}
