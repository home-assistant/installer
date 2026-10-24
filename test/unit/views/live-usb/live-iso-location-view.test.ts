import { expect, fixtureSync, html } from "@open-wc/testing";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import { fireEvent } from "../../../../src/utils/fire-event.js";
import "../../../../src/views/live-usb/live-iso-location-view.js";
import type { LiveIsoLocationView } from "../../../../src/views/live-usb/live-iso-location-view.js";
import {
  deferred,
  ipcError,
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
        return { hai_live_found: true };
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

    fireEvent(el.shadowRoot!.querySelector("info-dialog")!, "dialog-primary");
    expect(await checking).to.equal(true);
    expect(wizardState.getState().selections.liveIsoOverwrite).to.equal(true);
  });

  it("doesn't show a problem with a name that was changed during the check", async () => {
    const el = fixtureSync<LiveIsoLocationView>(
      html`<live-iso-location-view></live-iso-location-view>`
    );
    await settle();
    const checking = el.check();
    const [, name] = el.shadowRoot!.querySelectorAll("wa-input");
    name.value = "fixed.iso";
    name.dispatchEvent(new Event("input"));
    location.reject(ipcError("invalid_file_name", "No separators"));

    expect(await checking).to.equal(false);
    await settle();
    expect(el.shadowRoot!.querySelector(".notice.error")).to.not.exist;
  });

  it("asks for Next on Enter in the folder or the file name, not on Browse", async () => {
    const el = fixtureSync<LiveIsoLocationView>(
      html`<live-iso-location-view></live-iso-location-view>`
    );
    await settle();
    let next = 0;
    el.addEventListener("wizard-next", () => next++);
    const enter = () =>
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        composed: true,
      });

    const browse = el.shadowRoot!.querySelector("wa-button")!;
    await browse.updateComplete;
    browse.shadowRoot!.querySelector("button")!.dispatchEvent(enter());
    expect(next).to.equal(0);

    const fields = [...el.shadowRoot!.querySelectorAll<WaInput>("wa-input")];
    await Promise.all(fields.map((field) => field.updateComplete));
    for (const field of fields) field.input.dispatchEvent(enter());
    expect(next).to.equal(2);
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
