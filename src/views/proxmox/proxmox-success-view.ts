import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import {
  DEFAULT_PROXMOX_NODE,
  DEFAULT_PROXMOX_VM_ID,
  DEFAULT_PROXMOX_VM_NAME,
} from "../../state/vm-defaults.js";
import { openExternalLink } from "../../utils/external-url.js";

import "../../components/install-success.js";

@customElement("proxmox-success-view")
export class ProxmoxSuccessView extends LitElement {
  static styles = css`
    :host {
      display: block;
      height: 100%;
    }
  `;

  @state()
  private _wizardState: WizardState = wizardState.getState();

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
    const selections = this._wizardState.selections;
    const vmName = selections.vmName || DEFAULT_PROXMOX_VM_NAME;
    const vmId = selections.proxmoxVmId || DEFAULT_PROXMOX_VM_ID;
    const node = selections.proxmoxNode || DEFAULT_PROXMOX_NODE;
    const ipAddress = selections.ipAddress;
    const haUrl = ipAddress
      ? `http://${ipAddress}`
      : "http://homeassistant.local";
    const displayUrl = ipAddress || "homeassistant.local";

    return html`
      <install-success
        .subtitle=${localize(
          "views.proxmox.proxmox_success_view.home_assistant_is_now_running_on_proxmox_as_value_vm_value_on_node_value",
          { value0: vmName, value1: vmId, value2: node }
        )}
        .steps=${[
          localize(
            "views.proxmox.proxmox_success_view.wait_a_few_minutes_for_home_assistant_to_complete_its_initial_setup"
          ),
          html`${localizeContent(
            "views.proxmox.proxmox_success_view.open_value_in_your_browser",
            {
              value0: html`<a
                href=${haUrl}
                target="_blank"
                rel="noopener noreferrer"
                @click=${(event: Event) => openExternalLink(event, haUrl)}
              >
                ${displayUrl}
              </a>`,
            }
          )}`,
          localize(
            "views.proxmox.proxmox_success_view.create_your_user_account_and_start_automating"
          ),
        ]}
        .tip=${html`${localizeContent(
          "views.proxmox.proxmox_success_view.value_you_can_manage_your_home_assistant_virtual_machine_anytime_from_the_p",
          {
            value0: html`<strong
              >${localize("views.proxmox.proxmox_success_view.tip")}</strong
            >`,
          }
        )}`}
      ></install-success>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "proxmox-success-view": ProxmoxSuccessView;
  }
}
