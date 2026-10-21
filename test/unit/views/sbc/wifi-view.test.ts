import { expect, fixture, html } from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/sbc/wifi-view.js";
import type { WifiView } from "../../../../src/views/sbc/wifi-view.js";
import { settle } from "../../tauri-ipc.js";

describe("wifi-view", () => {
  afterEach(() => wizardState.reset());

  it("collects the network while the switch is on", async () => {
    wizardState.startFlow("sbc");
    const el = await fixture<WifiView>(html`<wifi-view></wifi-view>`);
    const root = el.shadowRoot!;
    const toggle = root.querySelector<HTMLInputElement>("wa-switch")!;
    expect(root.querySelector("wa-input")).to.not.exist;
    expect(root.textContent).to.contain("hidden networks aren't supported");

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await settle();
    const [ssid, password] =
      root.querySelectorAll<HTMLInputElement>("wa-input");
    ssid.value = "Home";
    ssid.dispatchEvent(new Event("input"));
    password.value = "1234";
    password.dispatchEvent(new Event("input"));
    await settle();
    expect(wizardState.getState().selections.wifi).to.deep.equal({
      ssid: "Home",
      password: "1234",
    });
    expect(password.getAttribute("hint")).to.contain("8 to 63 characters");
    expect(ssid.getAttribute("hint")).to.equal("");

    // 17 characters, but 34 bytes
    ssid.value = "é".repeat(17);
    ssid.dispatchEvent(new Event("input"));
    await settle();
    expect(ssid.getAttribute("hint")).to.contain("too long");

    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await settle();
    expect(wizardState.getState().selections.wifi).to.equal(undefined);
    expect(root.querySelector("wa-input")).to.not.exist;
  });
});
