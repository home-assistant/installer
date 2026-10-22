import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { proxmoxVmConfig } from "../../state/vm-defaults.js";
import { getHaosRelease } from "../../api/commands.js";
import {
  HaosVersion,
  renderHaosVersionRow,
  renderSummaryIcon,
  renderSummaryRow,
  summaryStyles,
} from "../../components/summary-card.js";
import { formatDiskSize, formatRam } from "../../utils/format.js";
import { mdiHarddisk, mdiMonitor, mdiServer } from "../../utils/icons.js";

@customElement("proxmox-confirm-view")
export class ProxmoxConfirmView extends LitElement {
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

      .icon-container .proxmox-icon {
        fill: var(--ha-primary-color, #03a9f4);
      }
    `,
  ];

  @state()
  private _wizardState: WizardState = wizardState.getState();

  private readonly _haosVersion = new HaosVersion(this, () =>
    getHaosRelease(undefined, "ova")
  );

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
    const config = proxmoxVmConfig(this._wizardState.selections);

    return html`
      <h2>${localize("common.confirm.ready_to_install")}</h2>
      <p class="subtitle">${localize("common.vm.confirm_subtitle")}</p>

      <div class="summary-card">
        <!-- Proxmox Server -->
        ${renderSummaryRow(
          this._renderProxmoxIcon(),
          localize("common.proxmox_server"),
          localizeContent("views.proxmox.proxmox_confirm_view.node_summary", {
            node: config.node,
          }),
          html`<p class="summary-detail">
              ${localizeContent(
                "views.proxmox.proxmox_confirm_view.storage_summary",
                { storage: config.storage }
              )}
            </p>
            <p class="summary-detail">
              ${localize("views.proxmox.proxmox_confirm_view.bridge_summary", {
                bridge: config.bridge,
              })}
              ${config.vlan_tag != null
                ? html`<br />${localize(
                      "views.proxmox.proxmox_confirm_view.vlan_tag_value",
                      { tag: config.vlan_tag }
                    )}`
                : ""}
            </p>`
        )}

        <div class="divider"></div>

        <!-- VM Configuration -->
        ${renderSummaryRow(
          renderSummaryIcon(mdiMonitor),
          localize("common.virtual_machine"),
          localizeContent("views.proxmox.proxmox_confirm_view.name_and_id", {
            name: config.name,
            id: config.vm_id,
          }),
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

  private _renderProxmoxIcon() {
    // The icon the Proxmox option has on the path selection
    return html`
      <svg
        class="proxmox-icon"
        viewBox="0 0 24 24"
        role="img"
        aria-label=${localize("views.proxmox.proxmox_confirm_view.proxmox")}
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d=${mdiServer} />
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "proxmox-confirm-view": ProxmoxConfirmView;
  }
}
