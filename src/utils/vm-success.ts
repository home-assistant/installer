/**
 * What the UTM and Proxmox success views share: the next steps once the VM
 * runs, and how their tips start.
 */
import { html } from "lit";
import { localize, localizeContent } from "../localization/localize.js";
import { renderExternalLink } from "./external-link.js";
import { HOME_ASSISTANT_HOST, homeAssistantUrl } from "./external-url.js";

/**
 * Wait for Home Assistant, open it at the VM's address, or at the name it
 * announces when the install found none, and create an account.
 */
export function vmSuccessSteps(ipAddress: string | undefined) {
  return [
    localize("common.vm.step_wait"),
    html`${localizeContent("common.vm.step_open", {
      // The step already says it opens in the browser
      url: renderExternalLink(
        homeAssistantUrl(ipAddress),
        ipAddress || HOME_ASSISTANT_HOST,
        { hint: false }
      ),
    })}`,
    localize("common.vm.step_onboard"),
  ];
}

/** The bold "Tip:" a VM success view's tip starts with */
export function vmTipPrefix() {
  return html`<strong>${localize("common.vm.tip")}</strong>`;
}
