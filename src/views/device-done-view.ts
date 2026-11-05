import { LitElement, css, html } from "lit";
import { customElement } from "lit/decorators.js";
import { localize, localizeContent } from "../localization/localize.js";
import { WizardStateController } from "../state/wizard-state-controller.js";
import {
  renderAnnouncedName,
  renderHomeAssistantLink,
  renderIpUrlPlaceholder,
} from "../utils/device-access.js";
import {
  EXTERNAL_LINK_HINT_STYLE,
  EXTERNAL_LINK_REL,
  EXTERNAL_LINK_TARGET,
  homeAssistantUrl,
  openExternalLink,
} from "../utils/external-url.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "../components/install-success.js";

/**
 * The last step for a device: once Home Assistant is ready, a button opens
 * it at the address the waiting step found it at, where it asks for an
 * account itself. A wait that was skipped may not have found it, or not
 * seen it finish, so then it says how long to wait and how to find it
 * without the installer.
 */
@customElement("device-done-view")
export class DeviceDoneView extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100%;
    }

    .open {
      margin: 0 0 2rem;
    }
  `;

  private readonly _wizard = new WizardStateController(this);

  render() {
    const { ipAddress, homeAssistantReady } = this._wizard.state.selections;
    if (ipAddress && homeAssistantReady) {
      return html`
        <install-success
          .subtitle=${localize("views.device_done_view.subtitle_ready")}
        >
          <p class="open" slot="action">
            <wa-button
              variant="brand"
              href=${homeAssistantUrl(ipAddress)}
              target=${EXTERNAL_LINK_TARGET}
              rel=${EXTERNAL_LINK_REL}
              @click=${openExternalLink}
              >${localize("views.device_done_view.open_home_assistant")}<span
                style=${EXTERNAL_LINK_HINT_STYLE}
                >${` ${localize("common.opens_in_browser")}`}</span
              ></wa-button
            >
          </p>
        </install-success>
      `;
    }

    return html`
      <install-success
        .subtitle=${localize("views.device_done_view.subtitle_installing")}
        .steps=${[
          localize("views.device_done_view.step_wait"),
          ipAddress
            ? html`${localizeContent("views.device_done_view.step_open", {
                // The step already says it opens in the browser
                url: renderHomeAssistantLink(ipAddress, { hint: false }),
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
