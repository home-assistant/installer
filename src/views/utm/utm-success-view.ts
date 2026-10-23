import { LitElement, html, css } from "lit";
import { localizeContent } from "../../localization/localize.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { utmVmConfig } from "../../state/vm-defaults.js";
import { vmSuccessSteps, vmTipPrefix } from "../../utils/vm-success.js";

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
    const { name } = utmVmConfig(selections);

    return html`
      <install-success
        .subtitle=${html`${localizeContent(
          "views.utm.utm_success_view.subtitle",
          { name }
        )}`}
        .steps=${vmSuccessSteps(selections.ipAddress)}
        .tip=${html`${localizeContent("views.utm.utm_success_view.manage_tip", {
          tip_prefix: vmTipPrefix(),
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
