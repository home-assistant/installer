import { LitElement, html, css } from "lit";
import { localize, localizeContent } from "../../localization/localize.js";
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
      min-height: 100%;
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
        .subtitle=${html`${localizeContent(
          "views.utm.utm_success_view.subtitle",
          { name: vmName }
        )}`}
        .steps=${[
          localize("common.vm.step_wait"),
          html`${localizeContent("common.vm.step_open", {
            url: html`<a
              href=${haUrl}
              target="_blank"
              rel="noopener noreferrer"
              @click=${openExternalLink}
            >
              ${displayUrl}
            </a>`,
          })}`,
          localize("common.vm.step_onboard"),
        ]}
        .tip=${html`${localizeContent("views.utm.utm_success_view.manage_tip", {
          tip_prefix: html`<strong>${localize("common.vm.tip")}</strong>`,
        })}`}
      ></install-success>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "utm-success-view": UtmSuccessView;
  }
}
