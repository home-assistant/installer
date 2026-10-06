export type Platform = "macos" | "windows" | "linux" | "other";

/**
 * The OS the app is running on. Reads the user agent, since
 * navigator.platform is deprecated and navigator.userAgentData is missing in
 * the WebKit webviews Tauri uses on macOS and Linux.
 */
export function getPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  if (/Linux/i.test(ua)) return "linux";
  return "other";
}
