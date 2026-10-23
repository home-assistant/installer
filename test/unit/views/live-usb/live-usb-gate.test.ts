import { expect, fixtureSync, html } from "@open-wc/testing";
import "../../../../src/views/live-usb/live-usb-gate.js";
import type { LiveUsbGate } from "../../../../src/views/live-usb/live-usb-gate.js";
import {
  deferred,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

describe("live-usb-gate", () => {
  let status: ReturnType<
    typeof deferred<{ hai_live_found: boolean; needs_admin: boolean }>
  >;

  beforeEach(() => {
    status = deferred();
    mockTauriIpc((cmd) => {
      if (cmd === "live_usb_status") return status.promise;
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  afterEach(() => {
    restoreTauriIpc();
  });

  async function revealAfterSlowStatus(gate: LiveUsbGate) {
    status.resolve({ hai_live_found: true, needs_admin: false });
    await settle();
    await gate.updateComplete;
  }

  it("focuses the content's heading once a slow check lets it show", async () => {
    const gate = fixtureSync<LiveUsbGate>(
      html`<live-usb-gate><h2>Where to save</h2></live-usb-gate>`
    );
    await revealAfterSlowStatus(gate);

    expect(document.activeElement).to.equal(gate.querySelector("h2"));
  });

  it("leaves focus alone when the user moved on during the check", async () => {
    const wrapper = fixtureSync<HTMLDivElement>(
      html`<div>
        <button>Elsewhere</button>
        <live-usb-gate><h2>Where to save</h2></live-usb-gate>
      </div>`
    );
    const elsewhere = wrapper.querySelector("button")!;
    const gate = wrapper.querySelector<LiveUsbGate>("live-usb-gate")!;
    elsewhere.focus();
    await revealAfterSlowStatus(gate);

    expect(document.activeElement).to.equal(elsewhere);
  });
});
