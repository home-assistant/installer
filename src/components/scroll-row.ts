import { LitElement, css, html, unsafeCSS } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { mdiChevronLeft, mdiChevronRight } from "../utils/icons.js";
import { reducedMotionStyles } from "../utils/view-accessibility.js";
import "./ha-svg-icon.js";

/** How much of what is out of sight fades in at an edge */
const FADE = unsafeCSS("3rem");

/**
 * A row too wide for its room scrolls sideways, and shows that it does. At
 * each edge with more beyond it, the row fades out and a button scrolls on.
 * The content is slotted, and lays itself out in one row; a row that fits
 * centers.
 *
 * The buttons are only for the pointer. The keyboard and screen readers go
 * through the row's content, which scrolls into sight as it takes the focus,
 * so they would only be stops that do nothing more. They also hide once the
 * row can't scroll their way, which would lose the focus.
 */
@customElement("scroll-row")
export class ScrollRow extends LitElement {
  static styles = [
    reducedMotionStyles,
    css`
      :host {
        display: block;
        position: relative;
      }

      /* Room around the content for a focus ring and a hover shadow, which
         a scrolling box cuts off. Only the buttons offer a way to scroll. */
      .viewport {
        display: flex;
        overflow-x: auto;
        padding: 0.5rem 0.25rem 1rem;
        scroll-padding-inline: ${FADE};
        scroll-snap-type: x proximity;
        scrollbar-width: none;
      }

      .viewport::-webkit-scrollbar {
        display: none;
      }

      ::slotted(*) {
        flex-shrink: 0;
        margin-inline: auto;
      }

      /* Out of sight past an edge fades out toward it */
      .viewport.more-back {
        mask-image: linear-gradient(to right, transparent, #000 ${FADE});
      }

      .viewport.more-forward {
        mask-image: linear-gradient(to left, transparent, #000 ${FADE});
      }

      :host(:dir(rtl)) .viewport.more-back {
        mask-image: linear-gradient(to left, transparent, #000 ${FADE});
      }

      :host(:dir(rtl)) .viewport.more-forward {
        mask-image: linear-gradient(to right, transparent, #000 ${FADE});
      }

      /* Both edges, either way the row reads. Last, and as specific as the
         right-to-left edges, so it wins over each of them. */
      .viewport.more-back.more-forward,
      :host(:dir(rtl)) .viewport.more-back.more-forward {
        mask-image: linear-gradient(
          to right,
          transparent,
          #000 ${FADE},
          #000 calc(100% - ${FADE}),
          transparent
        );
      }

      /* In the middle of the content, beside the room for its shadow */
      .scroll-button {
        position: absolute;
        top: calc(50% - 0.25rem);
        transform: translateY(-50%);
        box-sizing: border-box;
        width: 2.25rem;
        height: 2.25rem;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--ha-border-color);
        border-radius: 50%;
        background-color: var(--ha-card-background);
        box-shadow: var(--ha-card-hover-shadow);
        color: var(--ha-text-color);
        cursor: pointer;
        --mdc-icon-size: 20px;
        transition: border-color 0.2s ease;
      }

      .scroll-button:hover {
        border-color: var(--ha-primary-color);
      }

      .scroll-button[hidden] {
        display: none;
      }

      .back {
        inset-inline-start: 0;
      }

      .forward {
        inset-inline-end: 0;
      }

      /* The chevrons point the way the row reads */
      :host(:dir(rtl)) .scroll-button ha-svg-icon {
        transform: scaleX(-1);
      }
    `,
  ];

  /** Whether more is out of sight toward the start */
  @state()
  private _moreBack = false;

  /** Whether more is out of sight toward the end */
  @state()
  private _moreForward = false;

  @query(".viewport")
  private _viewport!: HTMLElement;

  /** The room the row has, and how wide its content is, change apart */
  private readonly _resize = new ResizeObserver(() => this._measure());

  /** Content that changes is measured at once, not only once it is drawn */
  private readonly _changes = new MutationObserver(() => this._measure());

  connectedCallback() {
    super.connectedCallback();
    void this.updateComplete.then(() => this._observe());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._resize.disconnect();
    this._changes.disconnect();
  }

  render() {
    return html`
      <div
        class="viewport ${classMap({
          "more-back": this._moreBack,
          "more-forward": this._moreForward,
        })}"
        @scroll=${this._measure}
      >
        <slot @slotchange=${this._observe}></slot>
      </div>
      <button
        class="scroll-button back"
        tabindex="-1"
        aria-hidden="true"
        ?hidden=${!this._moreBack}
        @mousedown=${this._keepFocus}
        @click=${this._scrollBack}
      >
        <ha-svg-icon .path=${mdiChevronLeft}></ha-svg-icon>
      </button>
      <button
        class="scroll-button forward"
        tabindex="-1"
        aria-hidden="true"
        ?hidden=${!this._moreForward}
        @mousedown=${this._keepFocus}
        @click=${this._scrollForward}
      >
        <ha-svg-icon .path=${mdiChevronRight}></ha-svg-icon>
      </button>
    `;
  }

  private _observe() {
    if (!this.isConnected || !this._viewport) return;
    this._resize.disconnect();
    this._changes.disconnect();
    this._resize.observe(this._viewport);
    for (const element of this.shadowRoot!.querySelector(
      "slot"
    )!.assignedElements()) {
      this._resize.observe(element);
      this._changes.observe(element, { childList: true, subtree: true });
    }
    this._measure();
  }

  private _measure() {
    const { scrollLeft, scrollWidth, clientWidth } = this._viewport;
    // Toward the start is to the right in a right-to-left row, where
    // scrolling goes below 0
    const scrolled = Math.abs(scrollLeft);
    this._moreBack = scrolled > 1;
    this._moreForward = scrolled < scrollWidth - clientWidth - 1;
  }

  // A click would focus the button, and drop the focus when it hides
  private _keepFocus(event: Event) {
    event.preventDefault();
  }

  private _scrollBack() {
    this._scrollBy(-1);
  }

  private _scrollForward() {
    this._scrollBy(1);
  }

  /** Most of a view on, toward the end for 1, the start for -1 */
  private _scrollBy(toward: 1 | -1) {
    const rtl = getComputedStyle(this).direction === "rtl";
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this._viewport.scrollBy({
      left: toward * (rtl ? -1 : 1) * this._viewport.clientWidth * 0.8,
      behavior: still ? "auto" : "smooth",
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "scroll-row": ScrollRow;
  }
}
