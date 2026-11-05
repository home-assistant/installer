import { expect, fixtureSync, html } from "@open-wc/testing";
import "../../../../src/views/live-usb/live-usb-gate.js";
import type { LiveUsbGate } from "../../../../src/views/live-usb/live-usb-gate.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

describe("live-usb-gate", () => {
  let status: ReturnType<typeof deferred<{ hai_live_found: boolean }>>;

  beforeEach(() => {
    status = deferred();
    mockTauriIpc((cmd) => {
      if (cmd === "live_usb_status") return status.promise;
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  afterEach(() => {
    restoreTauriIpc();
    wizardState.reset();
  });

  async function revealAfterSlowStatus(gate: LiveUsbGate) {
    status.resolve({ hai_live_found: true });
    await settle();
    await gate.updateComplete;
  }

  it("focuses the content's heading once a slow check lets it show", async () => {
    const gate = fixtureSync<LiveUsbGate>(
      html`<live-usb-gate><h2>Where to save</h2></live-usb-gate>`
    );
    await revealAfterSlowStatus(gate);

    const heading = gate.querySelector("h2")!;
    expect(document.activeElement).to.equal(heading);
    // Like every other step's heading, which is nothing to act on
    expect(heading.style.outline).to.equal("none");
  });

  it("shows a spinner, like other steps, while it checks", async () => {
    const gate = fixtureSync<LiveUsbGate>(
      html`<live-usb-gate><h2>Where to save</h2></live-usb-gate>`
    );
    await gate.updateComplete;

    const loading = gate.shadowRoot!.querySelector(".loading")!;
    expect(loading.querySelector("loading-spinner")).to.exist;
    expect(loading.textContent).to.contain("Loading");
    expect(gate.shadowRoot!.querySelector("slot")).to.not.exist;
  });

  it("explains a failed check like other steps that failed to load", async () => {
    const gate = fixtureSync<LiveUsbGate>(
      html`<live-usb-gate><h2>Where to save</h2></live-usb-gate>`
    );
    // A failed call carries no retryable flag, but checking is always safe
    status.reject("No answer");
    await settle();

    const root = gate.shadowRoot!;
    const message = root.querySelector(".error [data-focus-alert]")!;
    expect(message.textContent!.trim()).to.equal("No answer");
    expect(root.activeElement).to.equal(message);
    expect(root.querySelector(".error .error-icon")).to.exist;
    expect(root.querySelector(".error .error-help a")).to.exist;
    expect(root.querySelector(".error diagnostics-actions")).to.exist;
    expect(
      root.querySelector(".error wa-button")!.textContent!.trim()
    ).to.equal("Try again");
    expect(root.querySelector("slot")).to.not.exist;
    expect(wizardState.getState().selections.liveReady).to.equal(false);
  });

  it("explains a missing program in an error notice, which takes the focus", async () => {
    const gate = fixtureSync<LiveUsbGate>(
      html`<live-usb-gate><h2>Where to save</h2></live-usb-gate>`
    );
    status.resolve({ hai_live_found: false });
    await settle();

    const root = gate.shadowRoot!;
    const notice = root.querySelector("inline-notice")!;
    expect(notice.variant).to.equal("error");
    expect(notice.textContent).to.contain("HAI_LIVE_PATH");
    expect(root.activeElement).to.equal(notice);
    expect(root.querySelector("slot")).to.not.exist;
    expect(wizardState.getState().selections.liveReady).to.equal(false);
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

  it("keeps Try again, and focus on it, while checking again", async () => {
    const checks: ReturnType<typeof deferred<unknown>>[] = [];
    mockTauriIpc((cmd) => {
      if (cmd !== "live_usb_status") throw new Error(`unexpected ${cmd}`);
      const check = deferred<unknown>();
      checks.push(check);
      return check.promise;
    });
    const gate = fixtureSync<LiveUsbGate>(
      html`<live-usb-gate><h2>Where to save</h2></live-usb-gate>`
    );
    checks[0].reject(ipcError("internal", "No answer"));
    await settle();
    const retry = gate.shadowRoot!.querySelector("wa-button")!;
    retry.focus();

    retry.click();
    await settle();
    expect(checks).to.have.length(2);
    expect(gate.shadowRoot!.querySelector("wa-button")).to.equal(retry);
    expect(retry.loading).to.equal(true);
    expect(gate.shadowRoot!.activeElement).to.equal(retry);
    // Emptied while checking, so the same failure is read out again
    const alert = gate.shadowRoot!.querySelector("[data-focus-alert]")!;
    expect(alert.textContent!.trim()).to.equal("");

    checks[1].resolve({ hai_live_found: true });
    await settle();
    expect(gate.shadowRoot!.querySelector("slot")).to.exist;
    expect(wizardState.getState().selections.liveReady).to.equal(true);
  });

  it("ignores an earlier check that answers after a later one", async () => {
    const checks: ReturnType<typeof deferred<unknown>>[] = [];
    mockTauriIpc(() => {
      const check = deferred<unknown>();
      checks.push(check);
      return check.promise;
    });
    const gate = fixtureSync<LiveUsbGate>(
      html`<live-usb-gate><h2>Where to save</h2></live-usb-gate>`
    );
    checks[0].reject(ipcError("internal", "No answer"));
    await settle();
    gate.shadowRoot!.querySelector("wa-button")!.click();
    gate.shadowRoot!.querySelector("wa-button")!.click();
    await settle();
    expect(checks).to.have.length(3);

    checks[2].resolve({ hai_live_found: true });
    checks[1].resolve({ hai_live_found: false });
    await settle();
    expect(wizardState.getState().selections.liveReady).to.equal(true);
  });
});
