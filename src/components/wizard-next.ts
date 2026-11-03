import { fireEvent } from "../utils/fire-event.js";

/**
 * Go on from the step `view` shows, as Next does, once a card is picked.
 * Whatever Next waits for or asks first still applies.
 */
export function goToNextStep(view: HTMLElement) {
  fireEvent(view, "wizard-next");
}

/**
 * Enter in a step's text field goes on as Next does, as it would submit a
 * form. Like Next, it does nothing while Next can't be pressed, and waits
 * for whatever Next waits for. Listen on the `wa-input`s only: selects,
 * sliders and switches have their own use for Enter. Returns whether Enter
 * asked to go on.
 */
export function nextOnEnter(e: KeyboardEvent): boolean {
  // wa-input's own buttons (the password toggle) send their keydown through
  // the host too, and Enter there should reveal the password, not go on.
  // Enter that confirms an input method composition isn't a submit either.
  if (
    e.key !== "Enter" ||
    !(e.composedPath()[0] instanceof HTMLInputElement) ||
    e.isComposing
  ) {
    return false;
  }
  goToNextStep(e.currentTarget as HTMLElement);
  return true;
}
