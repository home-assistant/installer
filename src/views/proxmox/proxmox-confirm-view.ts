import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { customElement } from "lit/decorators.js";
import type { WizardState } from "../../state/wizard-state.js";
import { WizardStateController } from "../../state/wizard-state-controller.js";
import { proxmoxVmConfig } from "../../state/vm-defaults.js";
import { getHaosRelease } from "../../api/commands.js";
import {
  HaosVersion,
  renderSummaryRow,
  renderVmSummaryRows,
  summaryStyles,
} from "../../utils/summary-styles.js";
import { mdiServer } from "../../utils/icons.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";

@customElement("proxmox-confirm-view")
export class ProxmoxConfirmView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    summaryStyles,
    css`
      .icon-container .proxmox-icon {
        fill: var(--ha-primary-color, #03a9f4);
      }
    `,
  ];

  private readonly _wizard = new WizardStateController(this);

  private get _wizardState(): WizardState {
    return this._wizard.state;
  }

  private readonly _haosVersion = new HaosVersion(this, () =>
    getHaosRelease(undefined, "ova")
  );

  render() {
    // What the install creates, not the raw selections
    const config = proxmoxVmConfig(this._wizardState.selections);

    return html`
      ${renderStepHeading(
        localize("common.confirm.ready_to_install"),
        localize("common.vm.confirm_subtitle")
      )}

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

        ${renderVmSummaryRows(
          config,
          this._haosVersion.version,
          localizeContent("views.proxmox.proxmox_confirm_view.name_and_id", {
            name: config.name,
            id: config.vm_id,
          })
        )}
      </div>
    `;
  }

  private _renderProxmoxIcon() {
    // The icon the Proxmox option has on the path selection. The row's label
    // says Proxmox server, so it needs no name of its own.
    return html`
      <svg
        class="proxmox-icon"
        viewBox="0 0 24 24"
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
