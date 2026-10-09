import {
  expect,
  fixture,
  fixtureSync,
  html,
  waitUntil,
} from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/utm/utm-check-view.js";
import type { UtmCheckView } from "../../../../src/views/utm/utm-check-view.js";
import {
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

describe("utm-check-view", () => {
  beforeEach(() => {
    wizardState.startFlow("vm");
  });
  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  it("keeps Next gated after a string rejection and supports checking again", async () => {
    let attempts = 0;
    mockTauriIpc((cmd) => {
      expect(cmd).to.equal("check_utm_status");
      return ++attempts === 1
        ? Promise.reject(ipcError("utm", "Status check failed", true))
        : { installed: true, path: "/Applications/UTM.app", version: "4.5.0" };
    });
    const el = fixtureSync(html`<utm-check-view></utm-check-view>`);
    await settle();
    expect(el.shadowRoot!.textContent).to.contain("Error checking UTM");
    expect(wizardState.getState().selections.utmInstalled).to.be.false;
    const retry = el.shadowRoot!.querySelector("wa-button")!;
    expect(retry.textContent).to.contain("Try again");
    retry.click();
    await settle();
    expect(attempts).to.equal(2);
    expect(wizardState.getState().selections.utmInstalled).to.be.true;
    expect(el.shadowRoot!.textContent).to.contain(
      "Ready to create a Home Assistant virtual machine"
    );
  });

  it("keeps a missing UTM installation gated and offers its download", async () => {
    mockTauriIpc((cmd) => {
      expect(cmd).to.equal("check_utm_status");
      return { installed: false, path: null, version: null };
    });
    const el = fixtureSync(html`<utm-check-view></utm-check-view>`);
    await settle();
    expect(wizardState.getState().selections.utmInstalled).to.be.false;
    expect(el.shadowRoot!.textContent).to.contain("Download UTM");
    expect(el.shadowRoot!.textContent).to.contain("not installed");
  });
});

describe("utm-check-view artwork", () => {
  const bridge = window as unknown as Record<string, unknown>;
  beforeEach(() => wizardState.startFlow("vm"));
  afterEach(() => {
    delete bridge.__TAURI__;
    delete bridge.__TAURI_INTERNALS__;
    wizardState.reset();
  });

  for (const installed of [false, true]) {
    it(`shows ${installed ? "happy" : "sad"} Casita after checking UTM`, async () => {
      bridge.__TAURI__ = {};
      bridge.__TAURI_INTERNALS__ = {
        invoke: () => Promise.resolve({ installed, version: null }),
      };
      const el = await fixture<UtmCheckView>(
        html`<utm-check-view></utm-check-view>`
      );
      await waitUntil(
        () => el.shadowRoot!.querySelector("casita-mascot")!.mood !== "loading"
      );
      expect(el.shadowRoot!.querySelector("casita-mascot")!.mood).to.equal(
        installed ? "happy" : "sad"
      );
      expect(
        el.shadowRoot!.querySelector(".status-title")!.textContent
      ).to.include(installed ? "installed" : "not installed");
      if (!installed)
        expect(el.shadowRoot!.textContent).to.include("Download UTM");
    });
  }

  it("uses problem artwork alongside the error and retry control", async () => {
    bridge.__TAURI__ = {};
    bridge.__TAURI_INTERNALS__ = {
      invoke: () =>
        Promise.reject({
          code: "utm",
          message: "Mock check failed",
          retryable: true,
          details: {},
        }),
    };
    const el = await fixture<UtmCheckView>(
      html`<utm-check-view></utm-check-view>`
    );
    await waitUntil(
      () => el.shadowRoot!.querySelector("casita-mascot")!.mood === "problem"
    );
    expect(el.shadowRoot!.querySelector("casita-mascot")!.mood).to.equal(
      "problem"
    );
    expect(
      el.shadowRoot!.querySelector(".status-description")!.textContent
    ).to.include("Mock check failed");
    expect(el.shadowRoot!.textContent).to.include("Try again");
  });
});
