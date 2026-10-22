import { expect, fixture, html } from "@open-wc/testing";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/sbc/wifi-view.js";
import type { WifiView } from "../../../../src/views/sbc/wifi-view.js";
import { findByRole, fullA11ySnapshot } from "../../helpers/a11y.js";
import { settle } from "../../tauri-ipc.js";

/** The view with the switch turned on, and its two fields. */
async function mountOn() {
  wizardState.startFlow("sbc");
  const el = await fixture<WifiView>(html`<wifi-view></wifi-view>`);
  const toggle = el.shadowRoot!.querySelector<HTMLInputElement>("wa-switch")!;
  toggle.checked = true;
  toggle.dispatchEvent(new Event("change"));
  await settle();
  const [ssid, password] = el.shadowRoot!.querySelectorAll<WaInput>("wa-input");
  return { el, toggle, ssid, password };
}

async function type(input: WaInput, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await settle();
}

/** Move focus out of a field, like Tab or a click elsewhere does. */
async function leave(input: WaInput) {
  input.dispatchEvent(new Event("blur"));
  await settle();
}

const hintOf = (input: WaInput) =>
  input.querySelector('[slot="hint"]')!.textContent!.trim();

const invalid = (input: WaInput) => input.validity.customError;

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
    const [ssid, password] = root.querySelectorAll<WaInput>("wa-input");
    await type(ssid, "Home");
    await type(password, "12345678");
    expect(wizardState.getState().selections.wifi).to.deep.equal({
      ssid: "Home",
      password: "12345678",
    });
    expect(invalid(ssid)).to.be.false;
    expect(invalid(password)).to.be.false;

    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await settle();
    expect(wizardState.getState().selections.wifi).to.equal(undefined);
    expect(root.querySelector("wa-input")).to.not.exist;
  });

  it("says which characters a password can have before any are typed", async () => {
    const { ssid, password } = await mountOn();
    expect(hintOf(password)).to.equal(
      "8 to 63 characters: letters A to Z without accents, numbers, spaces and symbols such as ! or #"
    );
    // Untouched fields aren't wrong yet, though Next is off
    expect(hintOf(ssid)).to.equal("");
    expect(invalid(ssid)).to.be.false;
    expect(invalid(password)).to.be.false;
  });

  it("asks for the network name once a field is left without it", async () => {
    let { ssid } = await mountOn();
    await leave(ssid);
    expect(hintOf(ssid)).to.equal("Enter the network name.");
    expect(invalid(ssid)).to.be.true;
    await type(ssid, "Home");
    expect(hintOf(ssid)).to.equal("");
    expect(invalid(ssid)).to.be.false;
    wizardState.reset();

    // Filling in the password first and moving on also explains Next
    let password: WaInput;
    ({ ssid, password } = await mountOn());
    await type(password, "12345678");
    expect(hintOf(ssid)).to.equal("");
    await leave(password);
    expect(hintOf(ssid)).to.equal("Enter the network name.");
    expect(invalid(ssid)).to.be.true;
  });

  it("says when the network name is too long while it's typed", async () => {
    const { ssid } = await mountOn();
    // 17 characters, but 34 bytes
    await type(ssid, "é".repeat(17));
    expect(hintOf(ssid)).to.equal(
      "This network name is too long. Wi-Fi allows up to 32 characters, fewer with accents or emoji."
    );
    expect(invalid(ssid)).to.be.true;
    await type(ssid, "é".repeat(16));
    expect(hintOf(ssid)).to.equal("");
    expect(invalid(ssid)).to.be.false;
  });

  it("says when the network name has a tab in it", async () => {
    const { ssid } = await mountOn();
    await type(ssid, "Home\tNet");
    expect(hintOf(ssid)).to.equal(
      "Remove tabs and other invisible characters from the network name."
    );
    expect(invalid(ssid)).to.be.true;
  });

  it("says a password is too short once it's left, not while typing", async () => {
    const { password } = await mountOn();
    await type(password, "1234567");
    expect(hintOf(password)).to.contain("8 to 63 characters");
    expect(invalid(password)).to.be.false;

    await leave(password);
    expect(hintOf(password)).to.equal("Use at least 8 characters.");
    expect(invalid(password)).to.be.true;

    await type(password, "12345678");
    expect(hintOf(password)).to.contain("8 to 63 characters");
    expect(invalid(password)).to.be.false;
  });

  it("says when a password is too long, but takes a 64-digit key", async () => {
    const { password } = await mountOn();
    await type(password, "x".repeat(64));
    expect(hintOf(password)).to.equal("Use at most 63 characters.");
    expect(invalid(password)).to.be.true;

    await type(password, "0123456789abcdef".repeat(4));
    expect(hintOf(password)).to.contain("8 to 63 characters");
    expect(invalid(password)).to.be.false;
  });

  it("says which characters a password can't have", async () => {
    const { password } = await mountOn();
    await type(password, "Grüße2024!");
    expect(hintOf(password)).to.equal(
      "Use only letters A to Z without accents, numbers, spaces and symbols such as ! or #."
    );
    expect(invalid(password)).to.be.true;
    await type(password, "Gruesse2024!");
    expect(invalid(password)).to.be.false;
  });

  it("starts over when the switch is turned off and on", async () => {
    const { el, toggle, ssid, password } = await mountOn();
    await leave(ssid);
    await type(password, "123");
    await leave(password);
    expect(invalid(ssid)).to.be.true;
    expect(invalid(password)).to.be.true;

    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await settle();
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await settle();
    const fresh = el.shadowRoot!.querySelectorAll<WaInput>("wa-input");
    expect(hintOf(fresh[0])).to.equal("");
    expect(hintOf(fresh[1])).to.contain("8 to 63 characters");
    expect(invalid(fresh[0])).to.be.false;
    expect(invalid(fresh[1])).to.be.false;
  });

  it("judges values kept from an earlier visit right away", async () => {
    wizardState.startFlow("sbc");
    wizardState.setSelection("wifi", { ssid: "", password: "123" });
    const el = await fixture<WifiView>(html`<wifi-view></wifi-view>`);
    const [ssid, password] =
      el.shadowRoot!.querySelectorAll<WaInput>("wa-input");
    expect(hintOf(password)).to.equal("Use at least 8 characters.");
    expect(hintOf(ssid)).to.equal("Enter the network name.");
  });

  it("announces the error politely as the field's description", async () => {
    const { el, ssid } = await mountOn();
    const live = ssid.querySelector('[slot="hint"]')!;
    expect(live.getAttribute("aria-live")).to.equal("polite");
    expect(el.shadowRoot!.querySelector('[role="alert"]')).to.not.exist;

    await type(ssid, "Home\tNet");
    await ssid.updateComplete;
    const textbox = findByRole(await fullA11ySnapshot(), "textbox").find(
      (node) => node.name === "Network name"
    ) as { description?: string } | undefined;
    expect(textbox?.description).to.equal(
      "Remove tabs and other invisible characters from the network name."
    );
  });
});
