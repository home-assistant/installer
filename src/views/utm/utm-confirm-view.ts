import { localize } from "../../localization/localize.js";
import { LitElement, html } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { utmVmConfig } from "../../state/vm-defaults.js";
import { getUtmHaosRelease } from "../../api/commands.js";
import {
  HaosVersion,
  renderVmSummaryRows,
  summaryStyles,
} from "../../utils/summary-styles.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";

@customElement("utm-confirm-view")
export class UtmConfirmView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [stepStyles, summaryStyles];

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
        ${renderVmSummaryRows(config, this._haosVersion.version)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "utm-confirm-view": UtmConfirmView;
  }
}
