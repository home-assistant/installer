import { LitElement, css, html, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { windowZoom } from "../utils/text-size.js";
import "./ha-svg-icon.js";

/** Where the open panel sits, in CSS pixels at the zoom it opened at */
interface Place {
  top: number;
  end: number;
  zoom: number;
}

/**
 * An icon button at the end of a header, and the panel it opens below it.
 * Changing the text size zooms the window, but not the open panel: it keeps
 * its place and size on screen, so − and + stay under the pointer. It opens
 * at the new size next time.
 */
@customElement("header-menu")
export class HeaderMenu extends LitElement {
  /** Names the button and its panel */
  @property() label = "";

  @property() icon = "";

  @state()
  private _place?: Place;

  /** Undoes the zoom since the panel opened */
  @state()
  private _scale = 1;

  @query("button")
  private _button!: HTMLButtonElement;

  // A zoom resizes the window as CSS sees it, in the frame it shows in, so
  // the panel makes up for it in that same frame
  private readonly _onResize = () => {
    if (this._place) this._scale = this._place.zoom / windowZoom();
  };

  static styles = css`
    button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2.5rem;
      height: 2.5rem;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: none;
      color: var(--ha-secondary-text-color);
      cursor: pointer;
    }

    button:hover,
    button:has(+ :popover-open) {
      background: var(--ha-hover-fill);
      color: var(--ha-text-color);
    }

    button:focus-visible {
      outline: var(--wa-focus-ring);
      outline-offset: var(--wa-focus-ring-offset);
    }

    [popover] {
      inset: auto;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      border: 1px solid var(--ha-border-color);
      border-radius: var(--wa-border-radius-l);
      background: var(--ha-card-background);
      box-shadow: var(--wa-shadow-l);
      color: var(--ha-text-color);
      text-align: start;
    }

    .body {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      min-width: 12rem;
      padding: 1rem 1.25rem;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("resize", this._onResize);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("resize", this._onResize);
  }

  render() {
    const place = this._place;
    const scale = this._scale;
    const top = place ? place.top * scale : 0;
    return html`
      <button popovertarget="panel" title=${this.label}>
        <ha-svg-icon .path=${this.icon}></ha-svg-icon>
      </button>
      <div
        id="panel"
        popover
        role="dialog"
        aria-label=${this.label}
        style=${styleMap(
          place
            ? {
                top: `${top}px`,
                insetInlineEnd: `${place.end * scale}px`,
                maxHeight: `calc(100vh - ${top}px - 0.5rem)`,
              }
            : {}
        )}
        @beforetoggle=${this._onBeforeToggle}
      >
        <div class="body" style=${styleMap({ zoom: String(scale) })}>
          ${place
            ? html`<slot></slot>`
            : // Closed, it holds no controls, also for tools that read the
              // page without following slots, like Playwright in WebKit
              nothing}
        </div>
      </div>
    `;
  }

  private _onBeforeToggle(event: ToggleEvent) {
    this._scale = 1;
    if (event.newState !== "open") {
      this._place = undefined;
      return;
    }
    const button = this._button.getBoundingClientRect();
    const rtl = getComputedStyle(this).direction === "rtl";
    this._place = {
      top: button.bottom + 4,
      end: rtl
        ? button.left
        : document.documentElement.clientWidth - button.right,
      zoom: windowZoom(),
    };
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "header-menu": HeaderMenu;
  }
}
