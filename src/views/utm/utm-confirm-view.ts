import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { utmVmConfig } from "../../state/vm-defaults.js";
import { getUtmHaosRelease } from "../../api/commands.js";
import {
  HaosVersion,
  renderHaosVersionRow,
  renderSummaryIcon,
  renderSummaryRow,
  summaryStyles,
} from "../../components/summary-card.js";
import { formatDiskSize, formatRam } from "../../utils/format.js";
import { mdiHarddisk, mdiMonitor } from "../../utils/icons.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";

@customElement("utm-confirm-view")
export class UtmConfirmView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [stepStyles, summaryStyles, css``];

  @state()
  private _wizardState: WizardState = wizardState.getState();

  private readonly _haosVersion = new HaosVersion(this, getUtmHaosRelease);

  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = wizardState.subscribe((state) => {
      this._wizardState = state;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  render() {
    // What the install creates, not the raw selections
    const config = utmVmConfig(this._wizardState.selections);

    return html`
      ${renderStepHeading(
        localize("common.confirm.ready_to_install"),
        localize("common.vm.confirm_subtitle")
      )}

      <div class="summary-card">
        <!-- VM Configuration -->
        ${renderSummaryRow(
          renderSummaryIcon(mdiMonitor),
          localize("common.virtual_machine"),
          config.name,
          html`<p class="summary-detail">
            ${localizeContent("common.vm.cores_and_memory", {
              cores: config.cpu_cores,
              memory: formatRam(config.memory_mb),
            })}
          </p>`
        )}

        <div class="divider"></div>

        <!-- Disk Size -->
        ${renderSummaryRow(
          renderSummaryIcon(mdiHarddisk),
          localize("vm.disk_storage"),
          formatDiskSize(config.disk_size_gb),
          html`<p class="summary-detail">
            ${localize("common.vm.virtual_disk_description")}
          </p>`
        )}

        <div class="divider"></div>

        <!-- HAOS Version -->
        ${renderHaosVersionRow(this._haosVersion.version)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "utm-confirm-view": UtmConfirmView;
  }
}
