import { openUrl } from "@tauri-apps/plugin-opener";
import { localize } from "../localization/localize.js";

/** The name Home Assistant announces itself by on the local network */
export const HOME_ASSISTANT_HOST = "homeassistant.local";

/**
 * Where Home Assistant answers: at its address, or at the name it announces
 * while the address isn't known.
 */
export function homeAssistantUrl(address?: string | null): string {
  return `http://${address || HOME_ASSISTANT_HOST}`;
}

// What an <a> that leaves the installer carries besides its href. Clicking it
// opens the page through the opener; target and rel are what the browser falls
// back to when that handler doesn't run, such as a middle click, so the page
// opens beside the installer and can't reach back into it.
export const EXTERNAL_LINK_TARGET = "_blank";
export const EXTERNAL_LINK_REL = "noopener noreferrer";

// The hint that such a link opens in the browser is hidden from sight, but not
// from screen readers. Inline, so it hides in any shadow root without each one
// including a sheet for it.
export const EXTERNAL_LINK_HINT_STYLE =
  "position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0";

export async function openExternalUrl(url: string) {
  try {
    await openUrl(url);
  } catch {
    // Fallback for development/web. Web links only, and not only HTTPS:
    // Home Assistant itself is plain HTTP on the local network. The new page
    // can't reach back into this one.
    if (isWebLink(url)) {
      window.open(url, EXTERNAL_LINK_TARGET, "noopener,noreferrer");
    }
  }
}

// Click handler for an <a>: opens its href outside the installer
export async function openExternalLink(event: Event) {
  event.preventDefault();
  const url = (event.currentTarget as HTMLAnchorElement).getAttribute("href");
  if (url) await openExternalUrl(url);
}

/**
 * An external link in plain DOM, for where Lit may be what failed. Everything
 * else renders it with renderExternalLink().
 */
export function createExternalLink(
  url: string,
  text: string
): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = url;
  link.target = EXTERNAL_LINK_TARGET;
  link.rel = EXTERNAL_LINK_REL;
  link.addEventListener("click", (event) => void openExternalLink(event));
  const hint = document.createElement("span");
  hint.style.cssText = EXTERNAL_LINK_HINT_STYLE;
  hint.textContent = ` ${localize("common.opens_in_browser")}`;
  link.append(text, hint);
  return link;
}

function isWebLink(url: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
