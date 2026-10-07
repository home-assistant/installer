import { expect, fixture, html } from "@open-wc/testing";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import "../../../../src/views/proxmox/proxmox-connect-view.js";
import type { ProxmoxConnectView } from "../../../../src/views/proxmox/proxmox-connect-view.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import { findByRole, fullA11ySnapshot } from "../../helpers/a11y.js";

async function renderView() {
  const el = await fixture<ProxmoxConnectView>(
    html`<proxmox-connect-view></proxmox-connect-view>`
  );
  const inputs = [...el.shadowRoot!.querySelectorAll("wa-input")] as WaInput[];
  await Promise.all(inputs.map((input) => input.updateComplete));
  return { el, inputs };
}

function nativeInput(input: WaInput): HTMLInputElement {
  return input.shadowRoot!.querySelector("input")!;
}

async function typeInto(el: ProxmoxConnectView, input: WaInput, value: string) {
  const native = nativeInput(input);
  native.value = value;
  native.dispatchEvent(
    new InputEvent("input", { bubbles: true, composed: true })
  );
  await el.updateComplete;
}

describe("proxmox-connect-view", () => {
  beforeEach(() => {
    wizardState.reset();
  });

  it("gives each credential field the autocomplete hint password managers expect", async () => {
    const { inputs } = await renderView();

    const fields = inputs.map((input) => {
      const native = nativeInput(input);
      return {
        id: native.id,
        type: native.type,
        autocomplete: native.getAttribute("autocomplete"),
      };
    });

    expect(fields).to.deep.equal([
      { id: "server-url", type: "url", autocomplete: "url" },
      { id: "username", type: "text", autocomplete: "username" },
      { id: "password", type: "password", autocomplete: "current-password" },
    ]);
  });

  it("turns off autocapitalize and spellcheck for the URL and username", async () => {
    const { inputs } = await renderView();

    for (const input of inputs.slice(0, 2)) {
      const native = nativeInput(input);
      expect(native.getAttribute("autocapitalize")).to.equal("off");
      expect(native.spellcheck).to.be.false;
    }
  });

  it("exposes each field as a labelled textbox", async () => {
    await renderView();

    const names = findByRole(await fullA11ySnapshot(), "textbox").map(
      (node) => node.name
    );

    expect(names).to.include.members(["Server URL", "Username", "Password"]);
  });

  it("tells the user the server certificate is not verified", async () => {
    const { el } = await renderView();

    const notice = el.shadowRoot!.querySelector("wa-callout");
    expect(notice).to.exist;
    expect(notice!.textContent).to.include("self-signed certificate");
    expect(notice!.textContent).to.include("without checking it");
  });

  it("updates the form state as the user types", async () => {
    const { el, inputs } = await renderView();
    expect(el.isFormValid()).to.be.false;

    await typeInto(el, inputs[0], "https://192.168.1.100:8006");
    await typeInto(el, inputs[2], "secret");

    expect(el.isFormValid()).to.be.true;
  });

  it("rejects a server URL that is not HTTPS", async () => {
    const { el, inputs } = await renderView();
    await typeInto(el, inputs[0], "http://192.168.1.100:8006");
    await typeInto(el, inputs[2], "secret");

    expect(el.isFormValid()).to.be.false;
    expect(await el.connect()).to.be.false;
    await el.updateComplete;

    const error = el.shadowRoot!.querySelector(".status-description");
    expect(error!.textContent).to.include("must use HTTPS");
  });

  it("asks for the missing fields before connecting", async () => {
    const { el } = await renderView();

    expect(await el.connect()).to.be.false;
    await el.updateComplete;

    const error = el.shadowRoot!.querySelector(".status-description");
    expect(error!.textContent).to.include("fill in all fields");
  });

  /** Count the Next requests the view sends to the wizard. */
  function countNext(el: ProxmoxConnectView) {
    const counter = { next: 0 };
    el.addEventListener("wizard-next", () => counter.next++);
    return counter;
  }

  const enter = (init: KeyboardEventInit = {}) =>
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      composed: true,
      ...init,
    });

  it("asks the wizard for Next on Enter in a field, not on the password toggle", async () => {
    const { el, inputs } = await renderView();
    const counter = countNext(el);

    const toggle = inputs[2].shadowRoot!.querySelector(".password-toggle")!;
    toggle.dispatchEvent(enter());
    expect(counter.next, "Enter on the password toggle").to.equal(0);

    nativeInput(inputs[2]).dispatchEvent(enter());
    expect(counter.next, "Enter in the password field").to.equal(1);
  });

  it("ignores Enter that confirms an input method composition", async () => {
    const { el, inputs } = await renderView();
    const counter = countNext(el);

    nativeInput(inputs[1]).dispatchEvent(enter({ isComposing: true }));
    expect(counter.next).to.equal(0);
  });

  describe("coming back from a later step", () => {
    beforeEach(() => {
      wizardState.setSelection("proxmoxSession", {
        server_url: "https://192.168.1.100:8006",
        ticket: "ticket",
        csrf_token: "csrf",
      });
      wizardState.setSelection("proxmoxUsername", "installer@pve");
      wizardState.setSelection("proxmoxConnected", true);
    });

    it("shows the server and user, but never the password", async () => {
      const { inputs } = await renderView();

      expect(nativeInput(inputs[0]).value).to.equal(
        "https://192.168.1.100:8006"
      );
      expect(nativeInput(inputs[1]).value).to.equal("installer@pve");
      expect(nativeInput(inputs[2]).value).to.equal("");
    });

    it("moves on without logging in again", async () => {
      const { el } = await renderView();

      // The password field is empty, so a new login would fail validation
      const session = wizardState.getState().selections.proxmoxSession;
      expect(await el.connect()).to.be.true;
      expect(wizardState.getState().selections.proxmoxSession).to.equal(
        session
      );
    });

    it("asks for the password again once a field changes", async () => {
      const { el, inputs } = await renderView();

      await typeInto(el, inputs[1], "root@pam");
      expect(await el.connect()).to.be.false;
      expect(wizardState.getState().selections.proxmoxConnected).to.be.false;
    });
  });

  it("disables the fields while connecting and stores the session", async () => {
    const { el, inputs } = await renderView();
    await typeInto(el, inputs[0], "https://192.168.1.100:8006/");
    await typeInto(el, inputs[2], "secret");

    const connecting = el.connect();
    await el.updateComplete;
    expect(inputs.every((input) => input.disabled)).to.be.true;

    expect(await connecting).to.be.true;
    await el.updateComplete;
    expect(inputs.some((input) => input.disabled)).to.be.false;

    const { selections } = wizardState.getState();
    expect(selections.proxmoxConnected).to.be.true;
    expect(selections.proxmoxSession?.server_url).to.equal(
      "https://192.168.1.100:8006"
    );
  });
});
