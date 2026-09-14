/**
 * Host platform detection for the webview the installer runs in.
 *
 * Derived from `navigator.userAgent` rather than the deprecated
 * `navigator.platform`. `navigator.userAgentData` would be the modern
 * replacement, but it is Chromium-only and so is undefined in the WKWebView
 * Tauri uses on macOS — exactly the platform these checks care about most.
 * The OS token in the user agent is present in every webview we ship on.
 */
function userAgent(): string {
  return navigator.userAgent.toLowerCase();
}

/** Whether the installer is running on macOS. */
export function isMacOS(): boolean {
  return userAgent().includes("mac");
}

/** Whether the installer is running on Linux. */
export function isLinux(): boolean {
  return userAgent().includes("linux");
}
