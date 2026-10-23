import { LitElement } from "lit";
import { property } from "lit/decorators.js";

/**
 * A card that is a button. Picking it goes on, so unlike the drive radios it
 * is never checked: a step shown again marks no earlier choice.
 */
export class CardButton extends LitElement {
  /** What the card stands for, for the view's click handler */
  @property({ type: String, reflect: true })
  value = "";

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "button");
    this.setAttribute("tabindex", "0");
    this.addEventListener("keydown", this._onKeyDown);
  }

  disconnectedCallback() {
    this.removeEventListener("keydown", this._onKeyDown);
    super.disconnectedCallback();
  }

  // The views attach `@click` to the host, so activating by keyboard just
  // re-dispatches a click rather than adding a second event to wire up.
  private _onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.click();
    }
  };
}
