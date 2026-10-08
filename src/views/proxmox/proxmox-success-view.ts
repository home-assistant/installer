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
        .subtitle=${html`Home Assistant is now running on Proxmox as "${vmName}"
        (VM ${vmId}) on node "${node}"`}
        .steps=${[
          html`Wait a few minutes for Home Assistant to complete its initial
          setup`,
          html`Open
            <a
              href=${haUrl}
              target="_blank"
              rel="noopener noreferrer"
              @click=${(event: Event) => openExternalLink(event, haUrl)}
            >
              ${displayUrl}
            </a>
            in your browser`,
          html`Create your user account and start automating!`,
        ]}
        .tip=${html`<strong>Tip:</strong> You can manage your Home Assistant
          virtual machine anytime from the Proxmox web interface. The VM is
          configured to start automatically when Proxmox boots.`}
      ></install-success>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "proxmox-success-view": ProxmoxSuccessView;
  }
}
