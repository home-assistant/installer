import { css, type LitElement, type ReactiveController } from "lit";

/** What `restoreFocus` focuses as it is, rather than like a heading. */
const CONTROLS = "a[href], button, input, select, wa-button, wa-select";

/**
 * Errors that `ViewAccessibility` focuses when they appear, which is what
 * reads them out. They carry `data-focus-alert`, not role="alert": an alert
 * is read out on its own, and again when it takes the focus. Alerts are
 * still followed, for views that haven't moved to the marker yet.
 */
const ALERTS = '[data-focus-alert], [role="alert"]';

export function activeElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

/** Whether an open modal dialog has the focus, leaving the rest inert. */
export function dialogHasFocus(): boolean {
  // Up through the slots and shadow roots the dialog's content sits in
  let node: Node | null = activeElement();
  while (node) {
    if (node instanceof HTMLDialogElement && node.open) return true;
    node =
      (node instanceof Element && node.assignedSlot) ||
      node.parentNode ||
      (node instanceof ShadowRoot ? node.host : null);
  }
  return false;
}

/** What `focusHeading` focuses once the dialog that has the focus closes. */
let pendingHeading: HTMLElement | null = null;

function stopWaiting() {
  pendingHeading = null;
  document.removeEventListener("wa-after-hide", focusPendingHeading, true);
}

function focusPendingHeading() {
  const heading = pendingHeading;
  stopWaiting();
  if (heading?.isConnected) focusHeading(heading);
}

/**
 * Continue from `heading`, as screen readers do where a new view starts.
 * Other text is focused like a heading.
 *
 * A modal dialog leaves the rest of the page inert, so while one has the
 * focus, the heading takes it only once the dialog has closed. The dialog
 * gives the focus back to what opened it, which may be gone by then, like
 * Cancel on the success step, and the focus would fall to the page.
 */
export function focusHeading(heading: HTMLElement) {
  // The latest place to continue from replaces one still waiting
  stopWaiting();
  // Focus only tells screen readers where to continue. A heading isn't
  // something to act on, so it gets no focus ring (Chromium and WebView2
  // draw one for focus set from script).
  heading.tabIndex = -1;
  heading.style.outline = "none";
  heading.focus();
  if (activeElement() !== heading && dialogHasFocus()) {
    pendingHeading = heading;
    // The dialog has closed and given back the focus by then
    document.addEventListener("wa-after-hide", focusPendingHeading, true);
  }
}

/** Focus new views and new errors, never ordinary form/progress updates. */
export class ViewAccessibility implements ReactiveController {
  private _headingFocused = false;
  private _initialFocus: Element | null = null;
  /** Each error on show, with the text it was read out with */
  private _alerts = new Map<HTMLElement, string>();
  /** The heading focused because an error went away with the focus in it */
  private _recovered: HTMLElement | null = null;

  constructor(private readonly host: LitElement) {
    host.addController(this);
  }

  hostConnected() {
    this._headingFocused = false;
    this._initialFocus = activeElement();
    this._alerts = new Map();
    this._recovered = null;
  }

  hostUpdated() {
    if (!this.host.isConnected) return;
    const alerts = new Map<HTMLElement, string>();
    for (const alert of this.host.renderRoot.querySelectorAll<HTMLElement>(
      ALERTS
    )) {
      const text = alert.textContent?.trim() ?? "";
      if (text) alerts.set(alert, text);
    }
    const cleared = [...this._alerts.keys()].some(
      (alert) => !alerts.has(alert)
    );
    const recovering = cleared && !this.host.matches(":focus-within");
    if (recovering) {
      // Retry can remove a focused footer button outside this view. Remember
      // it so a delayed heading still won't interrupt subsequent navigation.
      this._headingFocused = false;
      this._initialFocus = activeElement();
    }
    // An error is new when it appears or says something else, never because
    // another one went away. Of several at once, the first takes the focus.
    const added = [...alerts.keys()].find(
      (alert) => this._alerts.get(alert) !== alerts.get(alert)
    );
    if (added) {
      focusHeading(added.querySelector<HTMLElement>("h1, h2") ?? added);
      this._headingFocused = true;
    } else if (!this._headingFocused) {
      const heading = this.host.renderRoot.querySelector<HTMLElement>("h1, h2");
      if (heading) {
        const active = activeElement();
        // A delayed load must not interrupt someone who already moved on.
        if (active === this._initialFocus || active === document.body) {
          focusHeading(heading);
          // Only a stand-in: the view may know a better place to continue
          if (recovering) this._recovered = heading;
        }
        this._headingFocused = true;
      }
    }
    this._alerts = alerts;
  }

  /**
   * Continue from `target` when an update removed the control that had
   * focus, as when a button gives way to what it loaded. Focus would
   * otherwise fall to the page, and a screen reader start over from the top.
   * Also replaces the heading this controller stood in with when an error
   * went away together with the focus. Focus anywhere else is left alone.
   * Text is focused like a heading.
   */
  restoreFocus(target: HTMLElement | null | undefined) {
    const active = activeElement();
    const recovered = active !== null && active === this._recovered;
    this._recovered = null;
    if (!target || (active && active !== document.body && !recovered)) return;
    if (target.matches(CONTROLS)) {
      target.focus();
    } else {
      focusHeading(target);
    }
  }
}

/** Mount an empty live region before announcing its initial stage. */
export class LiveStatus implements ReactiveController {
  ready = false;
  private _cancel?: () => void;
  constructor(private readonly host: LitElement) {
    host.addController(this);
  }
  hostConnected() {
    this.ready = false;
    this.host.requestUpdate();
  }
  hostDisconnected() {
    this._cancel?.();
    this._cancel = undefined;
  }
  hostUpdated() {
    if (!this.host.isConnected || this.ready || this._cancel) return;
    const ready = () => {
      this._cancel?.();
      this._cancel = undefined;
      this.ready = true;
      if (this.host.isConnected) this.host.requestUpdate();
    };
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(ready);
    });
    const fallback = window.setTimeout(ready, 1000);
    this._cancel = () => {
      window.clearTimeout(fallback);
      window.cancelAnimationFrame(frame);
    };
  }
}

export const srOnlyStyles = css`
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
`;

// This sheet belongs in each animated component's shadow root, not just :root.
export const reducedMotionStyles = css`
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation: none !important;
      transition: none !important;
    }
  }
`;
