import { expect, fixtureSync, html } from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/live-usb/live-iso-location-view.js";
import type { LiveIsoLocationView } from "../../../../src/views/live-usb/live-iso-location-view.js";
import {
  deferred,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

describe("live-iso-location-view", () => {
  let location: ReturnType<typeof deferred<{ exists: boolean }>>;

  beforeEach(() => {
    wizardState.startFlow("minipc");
    wizardState.setSelection("liveMedia", "iso");
    wizardState.setSelection("liveIsoFolder", "/home/me");
    wizardState.setSelection("liveIsoName", "stick.iso");
    location = deferred();
    mockTauriIpc((cmd) => {
      if (cmd === "live_usb_status") {
        return { hai_live_found: true, needs_admin: false };
      }
      if (cmd === "check_iso_location") return location.promise;
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  it("asks before replacing an existing file", async () => {
    const el = fixtureSync<LiveIsoLocationView>(
      html`<live-iso-location-view></live-iso-location-view>`
    );
    const checking = el.check();
    location.resolve({ exists: true });
    await settle();

    el.shadowRoot!.querySelector("info-dialog")!.dispatchEvent(
      new CustomEvent("dialog-primary")
    );
    expect(await checking).to.equal(true);
    expect(wizardState.getState().selections.liveIsoOverwrite).to.equal(true);
  });

  it("settles a check that answers after the view was left", async () => {
    const el = fixtureSync<LiveIsoLocationView>(
      html`<live-iso-location-view></live-iso-location-view>`
    );
    let result: boolean | undefined;
    void el.check().then((ok) => (result = ok));
    await settle();

    // Back or Cancel removes the view while the backend still checks
    el.remove();
    location.resolve({ exists: true });
    await settle();

    expect(result).to.equal(false);
    expect(wizardState.getState().selections.liveIsoOverwrite).to.not.equal(
      true
    );
  });
});
