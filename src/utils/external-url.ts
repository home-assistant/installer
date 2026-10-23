import { openUrl } from "@tauri-apps/plugin-opener";

/** The name Home Assistant announces itself by on the local network */
export const HOME_ASSISTANT_HOST = "homeassistant.local";

/**
 * Where Home Assistant answers: at its address, or at the name it announces
 * while the address isn't known.
 */
export function homeAssistantUrl(address?: string | null): string {
  return `http://${address || HOME_ASSISTANT_HOST}`;
}

export async function openExternalUrl(url: string) {
  try {
    await openUrl(url);
  } catch {
    // Fallback for development/web. Web links only, and not only HTTPS:
    // Home Assistant itself is plain HTTP on the local network. The new page
    // can't reach back into this one.
    if (isWebLink(url)) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }
}

// Click handler for an <a>: opens its href outside the installer
export async function openExternalLink(event: Event) {
  event.preventDefault();
  const url = (event.currentTarget as HTMLAnchorElement).getAttribute("href");
  if (url) await openExternalUrl(url);
}

function isWebLink(url: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
