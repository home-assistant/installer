import { LitElement, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";

/**
 * Shared radio-group behaviour for the single-select cards (device, drive).
 *
 * The views attach `@click` to the host element, so keyboard activation
 * re-dispatches a click instead of introducing a second event to wire up —
 * existing call sites keep working unchanged.
 */
export abstract class SelectableCard extends LitElement {
  @property({ type: Boolean })
  selected = false;

  @property({ type: Boolean })
  disabled = false;

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "radio");
    this.addEventListener("keydown", this._onKeyDown);
    this._syncA11y();
  }

  disconnectedCallback() {
    this.removeEventListener("keydown", this._onKeyDown);
    super.disconnectedCallback();
    // The card leaving the list can strand the group without a tab stop.
    this._syncSiblings();
  }

  protected updated(changed: PropertyValues) {
    super.updated(changed);
    this._syncA11y();
    // Selection moved, so the roving tab stop moved with it. Siblings do not
    // re-render on our state change, so they have to be told.
    if (changed.has("selected") || changed.has("disabled")) {
      this._syncSiblings();
    }
  }

  private _onKeyDown = (e: KeyboardEvent) => {
    if (this.disabled) {
      return;
    }

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.click();
      return;
    }

    const step = NEXT_KEYS.has(e.key) ? 1 : PREVIOUS_KEYS.has(e.key) ? -1 : 0;
    if (step === 0 && e.key !== "Home" && e.key !== "End") {
      return;
    }

    const cards = this._enabledSiblings();
    if (cards.length < 2) {
      return;
    }

    e.preventDefault();
    const target = this._keyTarget(cards, e.key, step);
    // Radios move selection as focus moves, which is what the views already
    // do on click — so activate rather than only focusing.
    target.focus();
    target.click();
  };

  private _keyTarget(
    cards: SelectableCard[],
    key: string,
    step: number
  ): SelectableCard {
    if (key === "Home") {
      return cards[0]!;
    }
    if (key === "End") {
      return cards[cards.length - 1]!;
    }
    const index = cards.indexOf(this);
    // Wrap around, matching the native radio group.
    return cards[(index + step + cards.length) % cards.length]!;
  }

  /** Cards of the same kind sharing our parent, in document order. */
  private _siblings(): SelectableCard[] {
    const parent = this.parentElement;
    if (!parent) {
      return [this];
    }
    return Array.from(
      parent.querySelectorAll<SelectableCard>(`:scope > ${this.localName}`)
    );
  }

  private _enabledSiblings(): SelectableCard[] {
    return this._siblings().filter((card) => !card.disabled);
  }

  private _syncA11y() {
    this.setAttribute("aria-checked", String(this.selected));

    if (this.disabled) {
      this.setAttribute("aria-disabled", "true");
      this.setAttribute("tabindex", "-1");
      return;
    }

    this.removeAttribute("aria-disabled");
    this.setAttribute("tabindex", this._isTabStop() ? "0" : "-1");
  }

  /**
   * Exactly one card in the group is reachable with Tab: the selected one, or
   * the first enabled card while nothing is selected. Arrow keys move from
   * there.
   */
  private _isTabStop(): boolean {
    if (this.selected) {
      return true;
    }
    const cards = this._enabledSiblings();
    return !cards.some((card) => card.selected) && cards[0] === this;
  }

  private _syncSiblings() {
    for (const card of this._siblings()) {
      if (card !== this) {
        card._syncA11y();
      }
    }
  }
}

const NEXT_KEYS = new Set(["ArrowDown", "ArrowRight"]);
const PREVIOUS_KEYS = new Set(["ArrowUp", "ArrowLeft"]);
