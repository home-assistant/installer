import type { ReactiveController, ReactiveControllerHost } from "lit";
import { wizardState, type WizardState } from "./wizard-state.js";

/**
 * The wizard state for a view, kept current while the view is in the page,
 * so the view renders again whenever it changes.
 */
export class WizardStateController implements ReactiveController {
  state: WizardState = wizardState.getState();

  private _unsubscribe?: () => void;

  /** `onChange` runs after each change while the view is in the page */
  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly onChange?: (state: WizardState) => void
  ) {
    host.addController(this);
  }

  hostConnected() {
    // It may have changed while the view was out of the page, or since it
    // was made
    const state = wizardState.getState();
    if (state !== this.state) {
      this.state = state;
      this.host.requestUpdate();
    }
    this._unsubscribe = wizardState.subscribe((state) => {
      this.state = state;
      this.host.requestUpdate();
      this.onChange?.(state);
    });
  }

  hostDisconnected() {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
  }
}
