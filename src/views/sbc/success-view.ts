import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { openExternalLink } from "../../utils/external-url.js";

import "../../components/install-success.js";

@customElement("success-view")
export class SuccessView extends LitElement {
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
    const deviceName =
      (this._wizardState.selections.deviceName as string) || "your device";

    return html`
      <install-success
        .subtitle=${html`Home Assistant has been installed on your ${deviceName}`}
        .steps=${[
          html`Remove the storage device from your computer`,
          html`Insert it into ${deviceName} and power it on`,
          html`Wait a few minutes for the initial setup to complete`,
          html`Open
            <a
              href="http://homeassistant.local"
              target="_blank"
              rel="noopener noreferrer"
              @click=${(event: Event) =>
                openExternalLink(event, "http://homeassistant.local")}
              >homeassistant.local</a
            >
            in your browser`,
        ]}
      ></install-success>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "success-view": SuccessView;
  }
}
