import { css, type LitElement, type ReactiveController } from "lit";

/** What `restoreFocus` focuses as it is, rather than like a heading. */
const CONTROLS = "a[href], button, input, select, wa-button, wa-select";

function activeElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

/** Focus new views and new errors, never ordinary form/progress updates. */
export class ViewAccessibility implements ReactiveController {
  private _headingFocused = false;
  private _initialFocus: Element | null = null;
  private _alert = "";
  /** The heading focused because an error went away with the focus in it */
  private _recovered: HTMLElement | null = null;

  constructor(private readonly host: LitElement) {
    host.addController(this);
  }

  hostConnected() {
    this._headingFocused = false;
    this._initialFocus = activeElement();
    this._alert = "";
    this._recovered = null;
  }

  hostUpdated() {
    if (!this.host.isConnected) return;
    const alert =
      this.host.renderRoot.querySelector<HTMLElement>('[role="alert"]');
    const text = alert?.textContent?.trim() ?? "";
    const recovering =
      !!this._alert && !text && !this.host.matches(":focus-within");
    if (recovering) {
      // Retry can remove a focused footer button outside this view. Remember
      // it so a delayed heading still won't interrupt subsequent navigation.
      this._headingFocused = false;
      this._initialFocus = activeElement();
    }
    if (text && text !== this._alert) {
      this._focus(alert!.querySelector<HTMLElement>("h1, h2") ?? alert!);
      this._headingFocused = true;
    } else if (!this._headingFocused) {
      const heading = this.host.renderRoot.querySelector<HTMLElement>("h1, h2");
      if (heading) {
        const active = activeElement();
        // A delayed load must not interrupt someone who already moved on.
        if (active === this._initialFocus || active === document.body) {
          this._focus(heading);
          // Only a stand-in: the view may know a better place to continue
          if (recovering) this._recovered = heading;
        }
        this._headingFocused = true;
      }
    }
    this._alert = text;
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
      this._focus(target);
    }
  }

  private _focus(element: HTMLElement) {
    // Focus only tells screen readers where the new view starts. A heading
    // isn't something to act on, so it gets no focus ring (Chromium and
    // WebView2 draw one for focus set from script).
    element.tabIndex = -1;
    element.style.outline = "none";
    element.focus();
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

/** CSS cannot stop SVG SMIL animations. Keep their initial, static artwork. */
export class ReducedSvgMotion implements ReactiveController {
  private readonly _media = matchMedia("(prefers-reduced-motion: reduce)");
  constructor(private readonly host: LitElement) {
    host.addController(this);
  }
  hostConnected() {
    this._media.addEventListener("change", this._apply);
  }
  hostDisconnected() {
    this._media.removeEventListener("change", this._apply);
  }
  hostUpdated() {
    this._apply();
  }
  private readonly _apply = () => {
    for (const svg of this.host.renderRoot.querySelectorAll("svg")) {
      if (this._media.matches) {
        svg.pauseAnimations();
        svg.setCurrentTime(0);
      } else {
        svg.unpauseAnimations();
      }
    }
  };
}
