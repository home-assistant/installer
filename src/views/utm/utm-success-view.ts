import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { DEFAULT_UTM_VM_NAME } from "../../state/vm-defaults.js";
import { openExternalLink } from "../../utils/external-url.js";

import "../../components/install-success.js";

@customElement("utm-success-view")
export class UtmSuccessView extends LitElement {
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
    const vmName = selections.vmName || DEFAULT_UTM_VM_NAME;
    const ipAddress = selections.ipAddress;
    const haUrl = ipAddress
      ? `http://${ipAddress}`
      : "http://homeassistant.local";
    const displayUrl = ipAddress || "homeassistant.local";

    return html`
      <install-success
        .subtitle=${html`Home Assistant is now running in UTM as "${vmName}"`}
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
          virtual machine anytime by opening UTM. The virtual machine will
          continue running in the background even after closing this installer.`}
      ></install-success>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "utm-success-view": UtmSuccessView;
  }
}
