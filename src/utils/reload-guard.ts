/**
 * Keep the webview from reloading the page, by its keys or by Reload in its
 * own context menu. A reload starts the app over on the welcome screen while
 * an installation goes on without it: no progress, no way to stop it, and a
 * new one is refused until it ends.
 */
export function preventReload(target: EventTarget = window) {
  target.addEventListener(
    "keydown",
    (event) => {
      if (isReloadKey(event as KeyboardEvent)) event.preventDefault();
    },
    { capture: true }
  );
  target.addEventListener("contextmenu", (event) => {
    if (!keepsContextMenu(event)) event.preventDefault();
  });
}

/**
 * F5 and Ctrl+R, with or without Shift. The browser goes by the key's place
 * for Ctrl+R, so a layout where it types another letter reloads too.
 */
function isReloadKey(event: KeyboardEvent): boolean {
  if (event.key === "F5" || event.key === "BrowserRefresh") return true;

  return (
    (event.ctrlKey || event.metaKey) &&
    (event.key.toLowerCase() === "r" || event.code === "KeyR")
  );
}

/**
 * A text field and selected text keep their menu, with Copy and Paste in
 * it. Neither has Reload.
 */
function keepsContextMenu(event: Event): boolean {
  const target = event.composedPath()[0];
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  ) {
    return true;
  }

  return !!document.getSelection()?.toString();
}
