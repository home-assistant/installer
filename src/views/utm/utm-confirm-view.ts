import { localize } from "../../localization/localize.js";
import { LitElement, html } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { customElement } from "lit/decorators.js";
import type { WizardState } from "../../state/wizard-state.js";
import { WizardStateController } from "../../state/wizard-state-controller.js";
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

  private readonly _wizard = new WizardStateController(this);

  private get _wizardState(): WizardState {
    return this._wizard.state;
  }

  private readonly _haosVersion = new HaosVersion(this, getUtmHaosRelease);

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
