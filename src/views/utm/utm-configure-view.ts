import { localize } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { logFrontendError } from "../../utils/diagnostics.js";
import { customElement, state } from "lit/decorators.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import "@home-assistant/webawesome/dist/components/input/input.js";
import { wizardState } from "../../state/wizard-state.js";
import { getSystemInfo } from "../../api/commands.js";
import type { SystemInfo } from "../../api/types.js";
import {
  DEFAULT_CPU_CORES,
  DEFAULT_DISK_SIZE_GB,
  DEFAULT_MEMORY_MB,
  DEFAULT_UTM_VM_NAME,
  isValidUtmVmName,
} from "../../state/vm-defaults.js";
import { settingStyles } from "../../utils/setting-styles.js";
import { fieldError, fieldErrorStyles } from "../../utils/field-error.js";
import "../../components/vm-resources.js";
import type { VmResourceValues } from "../../components/vm-resources.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";

@customElement("utm-configure-view")
export class UtmConfigureView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    reducedMotionStyles,
    settingStyles,
    fieldErrorStyles,
    css`
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
    `,
  ];

  @state()
  private _vmName = DEFAULT_UTM_VM_NAME;

  @state()
  private _cpuCores = DEFAULT_CPU_CORES;

  @state()
  private _memoryMb = DEFAULT_MEMORY_MB;

  @state()
  private _diskSizeGb = DEFAULT_DISK_SIZE_GB;

  @state()
  private _systemInfo: SystemInfo | null = null;

  connectedCallback() {
    super.connectedCallback();
    this._restoreSelections();
    void this._loadSystemInfo();
  }

  /**
   * Seed the form from what is already in the wizard state, so stepping back
   * to an earlier step and forward again keeps the user's settings. The
   * defaults above only apply on the first visit.
   */
  private _restoreSelections() {
    const selections = wizardState.getState().selections;
    this._vmName = selections.vmName ?? DEFAULT_UTM_VM_NAME;
    this._cpuCores = selections.cpuCores ?? DEFAULT_CPU_CORES;
    this._memoryMb = selections.memoryMb ?? DEFAULT_MEMORY_MB;
    this._diskSizeGb = selections.diskSizeGb ?? DEFAULT_DISK_SIZE_GB;
  }

  private async _loadSystemInfo() {
    try {
      const systemInfo = await getSystemInfo();

      // The user may have left this step while the lookup was in flight;
      // saving now would write over what the next step reads
      if (!this.isConnected) return;

      this._systemInfo = systemInfo;

      // Cap the selected values to what this system can offer
      const coreOptions = this._getCoreOptions();
      if (!coreOptions.includes(this._cpuCores)) {
        this._cpuCores = coreOptions[coreOptions.length - 1] || 2;
      }

      const memoryOptions = this._getMemoryOptions();
      if (!memoryOptions.includes(this._memoryMb)) {
        this._memoryMb = memoryOptions[memoryOptions.length - 1] || 2048;
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
    wizardState.setSelections({
      vmName: this._vmName,
      cpuCores: this._cpuCores,
      memoryMb: this._memoryMb,
      diskSizeGb: this._diskSizeGb,
    });
  }

  private get _nameError(): string | undefined {
    return isValidUtmVmName(this._vmName)
      ? undefined
      : localize("views.utm.utm_configure_view.vm_name_required");
  }

  private _onNameChange(e: Event) {
    // Kept as typed: falling back to the default here wrote it back into a
    // cleared field, in front of whatever was typed next. _nameError holds
    // Next back instead.
    this._vmName = (e.target as WaInput).value ?? "";
    this._saveSelections();
  }

  private _onResourcesChange(e: CustomEvent<VmResourceValues>) {
    this._cpuCores = e.detail.cpuCores;
    this._memoryMb = e.detail.memoryMb;
    this._diskSizeGb = e.detail.diskSizeGb;
    this._saveSelections();
  }

  private _getCoreOptions(): number[] {
    const maxCores = this._systemInfo?.cpu_cores || 8;
    // Offer cores in increments: 2, 4, 6, 8, etc. up to system max
    const options: number[] = [];
    for (let cores = 2; cores <= maxCores; cores += 2) {
      options.push(cores);
    }
    // If system has odd number of cores and we're missing the max, add max-1
    if (options.length === 0) {
      options.push(2);
    }
    return options;
  }

  private _getMemoryOptions(): number[] {
    const maxMemoryMb = this._systemInfo?.memory_mb || 16384;
    // Reserve 2GB for host system, offer rest in standard increments
    const availableMemoryMb = maxMemoryMb - 2048;

    const standardOptions = [
      2048, 4096, 6144, 8192, 12288, 16384, 24576, 32768, 49152, 65536,
    ];
    return standardOptions.filter((mb) => mb <= availableMemoryMb);
  }

  private _getDiskSizeOptions(): number[] {
    // Standard disk size options in GB
    return [32, 64, 128, 256, 512];
  }

  // MDI Icons (from https://materialdesignicons.com/)
  private _renderLabelIcon() {
    // mdi:label-outline
    return html`<svg viewBox="0 0 24 24">
      <path
        d="M16,17H5V7H16L19.55,12M17.63,5.84C17.27,5.33 16.67,5 16,5H5A2,2 0 0,0 3,7V17A2,2 0 0,0 5,19H16C16.67,19 17.27,18.66 17.63,18.15L22,12L17.63,5.84Z"
      />
    </svg>`;
  }

  render() {
    return html`
      ${renderStepHeading(
        localize("common.vm.configure_virtual_machine"),
        localize("views.utm.utm_configure_view.subtitle")
      )}

      <div class="config-card">
        <!-- VM Name -->
        <div class="setting-row">
          <div class="setting-icon">${this._renderLabelIcon()}</div>
          <div class="setting-content">
            <wa-input
              label=${localize("common.vm.display_name")}
              type="text"
              size="s"
              .value=${this._vmName}
              @input=${this._onNameChange}
              placeholder=${DEFAULT_UTM_VM_NAME}
              ${fieldError(this._nameError)}
            >
              <!-- In the hint slot, so the field describes itself with it.
                Not role="alert": ViewAccessibility focuses a new alert, which
                would pull focus out of the field halfway through typing -->
              <span slot="hint" class="name-hint" aria-live="polite"
                >${this._nameError ??
                localize("views.utm.utm_configure_view.vm_name_hint")}</span
              >
            </wa-input>
          </div>
        </div>

        <vm-resources
          .coreOptions=${this._getCoreOptions()}
          .memoryOptions=${this._getMemoryOptions()}
          .diskOptions=${this._getDiskSizeOptions()}
          .cpuCores=${this._cpuCores}
          .memoryMb=${this._memoryMb}
          .diskSizeGb=${this._diskSizeGb}
          @resources-change=${this._onResourcesChange}
        ></vm-resources>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "utm-configure-view": UtmConfigureView;
  }
}
