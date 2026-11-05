import { localize } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { wizardState } from "../../state/wizard-state.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";
import "./connect-instructions.js";

/**
 * Setting up the board so this computer sees its storage, a step of its own
 * where that takes more than plugging in a drive.
 */
@customElement("ha-hardware-connect-view")
export class HaHardwareConnectView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    css`
      ha-hardware-connect-instructions {
        margin-bottom: 0;
      }
    `,
  ];

  render() {
    return html`
      ${renderStepHeading(
        localize("views.ha_hardware.connect_view.title"),
        localize("views.ha_hardware.connect_view.subtitle")
      )}
      <ha-hardware-connect-instructions
        .hardware=${wizardState.getState().selections.haHardware}
        standalone
      ></ha-hardware-connect-instructions>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-hardware-connect-view": HaHardwareConnectView;
  }
}
