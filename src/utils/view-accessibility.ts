import { css, type LitElement, type ReactiveController } from "lit";

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

  constructor(private readonly host: LitElement) {
    host.addController(this);
  }

  hostConnected() {
    this._headingFocused = false;
    this._initialFocus = activeElement();
    this._alert = "";
  }

  hostUpdated() {
    if (!this.host.isConnected) return;
    const alert =
      this.host.renderRoot.querySelector<HTMLElement>('[role="alert"]');
    const text = alert?.textContent?.trim() ?? "";
    if (this._alert && !text && !this.host.matches(":focus-within")) {
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
        }
        this._headingFocused = true;
      }
    }
    this._alert = text;
  }

  private _focus(element: HTMLElement) {
    element.tabIndex = -1;
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

// This sheet belongs in each animated component's shadow root, not just :root.
export const reducedMotionStyles = css`
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
