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

@customElement("utm-confirm-view")
export class UtmConfirmView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    summaryStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        align-items: center;
        min-height: 100%;
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
        margin: 0 0 1.5rem 0;
        text-align: center;
      }
    `,
  ];

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
      <h2>${localize("common.confirm.ready_to_install")}</h2>
      <p class="subtitle">${localize("common.vm.confirm_subtitle")}</p>

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
