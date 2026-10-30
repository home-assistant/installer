/**
 * Reaching Home Assistant on a device, where the installer found it or
 * without that, as the waiting step and the last step both explain.
 */
import { html } from "lit";
import { localize } from "../localization/localize.js";
import { renderExternalLink } from "./external-link.js";
import { HOME_ASSISTANT_HOST, homeAssistantUrl } from "./external-url.js";

/** The name Home Assistant announces, as a link its sentence introduces */
export function renderAnnouncedName() {
  // The sentence already says it opens in the browser
  return renderExternalLink(homeAssistantUrl(), HOME_ASSISTANT_HOST, {
    hint: false,
  });
}

/** Home Assistant at the address the installer found it at, by name */
export function renderHomeAssistantLink(ipAddress: string | undefined) {
  // The sentence already says it opens in the browser
  return renderExternalLink(
    homeAssistantUrl(ipAddress),
    localize("common.device.home_assistant"),
    { hint: false }
  );
}

/** `http://<IP address>`, for the address a router or display shows */
export function renderIpUrlPlaceholder() {
  return html`<code dir="ltr"
    >http://&lt;<bdi>${localize("common.device.ip_address")}</bdi>&gt;</code
  >`;
}
