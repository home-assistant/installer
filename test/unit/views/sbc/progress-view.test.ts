import { expect, fixtureSync, html } from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/sbc/progress-view.js";
import type { ProgressView } from "../../../../src/views/sbc/progress-view.js";
import { mockTauriIpc, restoreTauriIpc } from "../../tauri-ipc.js";

describe("progress-view", () => {
  beforeEach(() => {
    wizardState.startFlow("sbc");
    // Nothing may reach the backend when the selections are incomplete
    mockTauriIpc((cmd) => {
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  it("reports a missing drive or device config to the app shell", async () => {
    // The app shell only shows Cancel and Try again after flash-error
    let errorEvents = 0;
    const onError = () => errorEvents++;
    document.addEventListener("flash-error", onError);

    try {
      const el = fixtureSync<ProgressView>(
        html`<progress-view></progress-view>`
      );
      await el.updateComplete;

      expect(el.hasError).to.be.true;
      expect(el.shadowRoot!.textContent).to.contain(
        "Missing drive or device configuration"
      );
      expect(errorEvents).to.equal(1);
    } finally {
      document.removeEventListener("flash-error", onError);
    }
  });
});
