import { LitElement, css, html } from "lit";
import { customElement } from "lit/decorators.js";
import { localize, localizeContent } from "../localization/localize.js";
import { WizardStateController } from "../state/wizard-state-controller.js";
import {
  renderAnnouncedName,
  renderIpUrlPlaceholder,
} from "../utils/device-access.js";
import { renderExternalLink } from "../utils/external-link.js";
import { homeAssistantUrl } from "../utils/external-url.js";
import "../components/install-success.js";

/**
 * The last step for a device: where to open Home Assistant, at the address
 * the waiting step found it at. A wait that was skipped may not have found
 * it, or not seen it finish, so then it says how long to wait and how to
 * find it without the installer.
 */
@customElement("device-done-view")
export class DeviceDoneView extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100%;
    }
  `;

  private readonly _wizard = new WizardStateController(this);

  render() {
    const { ipAddress, homeAssistantReady } = this._wizard.state.selections;
    const ready = !!ipAddress && !!homeAssistantReady;
    const url = ipAddress ? homeAssistantUrl(ipAddress) : "";

    return html`
      <install-success
        .subtitle=${ready
          ? localize("views.device_done_view.subtitle_ready")
          : localize("views.device_done_view.subtitle_installing")}
        .steps=${[
          ...(ready ? [] : [localize("views.device_done_view.step_wait")]),
          ipAddress
            ? html`${localizeContent("views.device_done_view.step_open", {
                // The step already says it opens in the browser
                url: renderExternalLink(url, url, { hint: false }),
              })}`
            : html`${localizeContent(
                "views.device_done_view.step_open_or_find",
                {
                  url: renderAnnouncedName(),
                  ip_url: renderIpUrlPlaceholder(),
                }
              )}`,
          localize("views.device_done_view.step_onboard"),
        ]}
      ></install-success>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "device-done-view": DeviceDoneView;
  }
}
