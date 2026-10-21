import { openUrl } from "@tauri-apps/plugin-opener";

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

export async function openExternalLink(event: Event, url: string) {
  event.preventDefault();
  await openExternalUrl(url);
}

function isWebLink(url: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
