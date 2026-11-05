import { LitElement } from "lit";
import { property } from "lit/decorators.js";

/**
 * A card that is a button. Picking it goes on, so unlike the drive radios it
 * is never checked: a step shown again marks no earlier choice.
 *
 * The card in the shadow root takes the role, so that what it shows can name
 * and describe it: a reference from the host can't reach into the shadow
 * root. Focusing the host focuses the card. Each card renders that element
 * with `_onKeyDown`, `_onKeyUp` and `_onBlur` on it.
 */
export class CardButton extends LitElement {
  static shadowRootOptions = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  /** What the card stands for, for the view's click handler */
  @property({ type: String, reflect: true })
  value = "";

  /** Space went down on the card, and comes up to act */
  private _spacePressed = false;

  /** Whether Space acts, as it does on a button */
  protected get _spaceActs() {
    return true;
  }

  // The views attach `@click` to the host, so activating by keyboard just
  // re-dispatches a click rather than adding a second event to wire up.
  // As on a native button, Enter acts when it goes down and Space when it
  // comes up. A held key acts once: repeats would open an external page
  // again and again.
  protected _onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!e.repeat) this.click();
    } else if (e.key === " " && this._spaceActs) {
      e.preventDefault();
      // A repeat belongs to a press that began where the key went down,
      // perhaps on another card before the focus moved here
      if (!e.repeat) this._spacePressed = true;
    }
  }

  protected _onKeyUp(e: KeyboardEvent) {
    if (e.key === " " && this._spacePressed) {
      this._spacePressed = false;
      this.click();
    }
  }

  // Moving on with Space still down cancels it, as on a native button
  protected _onBlur() {
    this._spacePressed = false;
  }
}
