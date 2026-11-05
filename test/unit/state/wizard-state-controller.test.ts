import { expect, fixture, html as fixtureHtml } from "@open-wc/testing";
import { LitElement, html, type ReactiveControllerHost } from "lit";
import {
  wizardState,
  type WizardState,
} from "../../../src/state/wizard-state.js";
import { WizardStateController } from "../../../src/state/wizard-state-controller.js";

/** A host that counts the updates its controller asks for. */
function host() {
  const result = {
    updates: 0,
    addController() {},
    removeController() {},
    requestUpdate() {
      result.updates++;
    },
    updateComplete: Promise.resolve(true),
  };
  return result satisfies ReactiveControllerHost & { updates: number };
}

class WizardStateHost extends LitElement {
  readonly wizard = new WizardStateController(this);

  render() {
    return html`${this.wizard.state.currentFlow ?? "none"}`;
  }
}
customElements.define("wizard-state-host", WizardStateHost);

describe("WizardStateController", () => {
  beforeEach(() => {
    wizardState.reset();
  });

  it("starts with the state there is when the view is made", () => {
    wizardState.startFlow("sbc");
    const view = host();
    const controller = new WizardStateController(view);

    expect(controller.state).to.equal(wizardState.getState());
    expect(view.updates).to.equal(0);
  });

  it("follows each change while the view is in the page", () => {
    const view = host();
    const heard: WizardState[] = [];
    const controller = new WizardStateController(view, (state) => {
      // The view reads the new state from it by then
      expect(controller.state).to.equal(state);
      heard.push(state);
    });
    controller.hostConnected();

    wizardState.startFlow("sbc");
    wizardState.setSelection("device", "rpi5");

    expect(controller.state).to.equal(wizardState.getState());
    expect(controller.state.selections.device).to.equal("rpi5");
    expect(view.updates).to.equal(2);
    expect(heard).to.have.length(2);
    expect(heard[1]).to.equal(wizardState.getState());
  });

  it("hears nothing once the view is out of the page", () => {
    const view = host();
    let changes = 0;
    const controller = new WizardStateController(view, () => changes++);
    controller.hostConnected();
    controller.hostDisconnected();
    const before = controller.state;

    wizardState.startFlow("sbc");

    expect(controller.state).to.equal(before);
    expect(view.updates).to.equal(0);
    expect(changes).to.equal(0);
  });

  it("catches up when the view comes back, without calling back for it", () => {
    const view = host();
    let changes = 0;
    const controller = new WizardStateController(view, () => changes++);
    controller.hostConnected();
    controller.hostDisconnected();
    wizardState.startFlow("vm");

    controller.hostConnected();

    expect(controller.state).to.equal(wizardState.getState());
    expect(view.updates).to.equal(1);
    expect(changes).to.equal(0);
  });

  it("asks for no update on connecting when nothing changed", () => {
    const view = host();
    const controller = new WizardStateController(view);
    controller.hostConnected();
    controller.hostDisconnected();

    controller.hostConnected();

    expect(view.updates).to.equal(0);
  });

  it("renders a view again on each change, and stops when it is removed", async () => {
    const el = await fixture<WizardStateHost>(
      fixtureHtml`<wizard-state-host></wizard-state-host>`
    );
    expect(el.shadowRoot!.textContent).to.equal("none");

    wizardState.startFlow("vm");
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).to.equal("vm");

    el.remove();
    wizardState.startFlow("sbc");
    expect(el.wizard.state.currentFlow).to.equal("vm");
  });
});
