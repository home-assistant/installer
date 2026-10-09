import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import "../../../../src/views/proxmox/proxmox-connect-view.js";
import type { ProxmoxConnectView } from "../../../../src/views/proxmox/proxmox-connect-view.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import { findByRole, fullA11ySnapshot } from "../../helpers/a11y.js";
import {
  mockTauriIpc,
  restoreTauriIpc,
  settle,
  deferred,
} from "../../tauri-ipc.js";
import type { ProxmoxCredentials } from "../../../../src/api/types.js";

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

  afterEach(() => restoreTauriIpc());

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
      { id: "totp", type: "text", autocomplete: "one-time-code" },
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

  it("does not show certificate approval until an untrusted certificate is detected", async () => {
    const { el } = await renderView();

    expect(el.shadowRoot!.querySelector("wa-dialog")!.open).to.be.false;
  });

  it("updates the form state as the user types", async () => {
    const { el, inputs } = await renderView();
    expect(el.isFormValid()).to.be.false;

    await typeInto(el, inputs[0], "https://192.168.1.100:8006");
    await typeInto(el, inputs[2], "secret");

    expect(el.isFormValid()).to.be.true;
  });

  it("shows the second-factor error, retries with the code, and clears it", async () => {
    const submitted: ProxmoxCredentials[] = [];
    mockTauriIpc((cmd, args) => {
      if (cmd === "proxmox_certificate_fingerprint") return null;
      expect(cmd).to.equal("proxmox_connect");
      const { credentials } = args as { credentials: ProxmoxCredentials };
      submitted.push(credentials);
      if (!credentials.totp) {
        throw "Proxmox two-factor authentication: Enter the current authenticator app code.";
      }
      return {
        server_url: credentials.server_url,
        ticket: "complete",
        csrf_token: "csrf",
      };
    });
    const { el, inputs } = await renderView();
    await typeInto(el, inputs[0], "https://192.168.1.100:8006");
    await typeInto(el, inputs[2], "secret");
    await typeInto(el, inputs[3], "   ");
    expect(await el.connect()).to.be.false;
    expect(submitted[0].totp).to.be.undefined;
    await el.updateComplete;
    expect(
      el.shadowRoot!.querySelector(".status-description")!.textContent
    ).to.include("two-factor");
    expect(wizardState.getState().selections.proxmoxConnected).to.be.false;
    expect(wizardState.getState().selections.proxmoxSession).to.be.undefined;
    await typeInto(el, inputs[3], " 012345 ");
    expect(await el.connect()).to.be.true;
    await el.updateComplete;
    await inputs[3].updateComplete;
    expect(submitted[1].totp).to.equal("012345");
    expect(nativeInput(inputs[3]).value).to.equal("");
    expect(wizardState.getState().selections.proxmoxSession?.ticket).to.equal(
      "complete"
    );
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
        certificate_sha256: Array(32).fill("AB").join(":"),
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
      const calls: string[] = [];
      mockTauriIpc((cmd) => {
        calls.push(cmd);
        throw new Error(`Unexpected command: ${cmd}`);
      });
      const { el } = await renderView();

      // The password field is empty, so a new login would fail validation
      const session = wizardState.getState().selections.proxmoxSession;
      expect(await el.connect()).to.be.true;
      expect(wizardState.getState().selections.proxmoxSession).to.equal(
        session
      );
      expect(session?.certificate_sha256).to.equal(
        Array(32).fill("AB").join(":")
      );
      expect(calls).to.deep.equal([]);
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

  it("waits for the user to trust the certificate before sending credentials and preserves the pin", async () => {
    const calls: string[] = [];
    const fingerprint = Array(32).fill("AB").join(":");
    mockTauriIpc((cmd, args) => {
      calls.push(cmd);
      if (cmd === "proxmox_certificate_fingerprint") return fingerprint;
      if (cmd === "proxmox_connect") {
        const { credentials } = args as {
          credentials: { certificate_sha256?: string };
        };
        expect(credentials.certificate_sha256).to.equal(fingerprint);
        return {
          server_url: "https://pve.example:8006",
          ticket: "ticket",
          csrf_token: "csrf",
          certificate_sha256: fingerprint,
        };
      }
      throw new Error(cmd);
    });
    const { el, inputs } = await renderView();
    await typeInto(el, inputs[0], "https://pve.example:8006");
    await typeInto(el, inputs[2], "secret");
    const connecting = el.connect();
    await settle();
    await el.updateComplete;
    expect(calls).to.deep.equal(["proxmox_certificate_fingerprint"]);
    const dialog = el.shadowRoot!.querySelector("wa-dialog")!;
    expect(dialog.open).to.be.true;
    expect(dialog.textContent).to.include(fingerprint);
    expect(dialog.textContent).to.include("https://pve.example:8006");
    dialog.querySelectorAll("wa-button")[1].click();
    expect(await connecting).to.be.true;
    expect(
      wizardState.getState().selections.proxmoxSession?.certificate_sha256
    ).to.equal(fingerprint);
    expect(await el.connect()).to.be.true;
    expect(calls).to.deep.equal([
      "proxmox_certificate_fingerprint",
      "proxmox_connect",
    ]);
  });

  it("asks once per server and certificate, even when a second attempt is needed", async () => {
    const calls: string[] = [];
    let fingerprint = Array(32).fill("AB").join(":");
    let attempts = 0;
    mockTauriIpc((cmd) => {
      calls.push(cmd);
      if (cmd === "proxmox_certificate_fingerprint") return fingerprint;
      attempts++;
      // The first login asks for an authenticator code
      throw {
        code: "proxmox_two_factor",
        message: "This account requires an authenticator app code.",
        retryable: false,
        details: {},
      };
    });
    const { el, inputs } = await renderView();
    await typeInto(el, inputs[0], "https://pve.example:8006");
    await typeInto(el, inputs[2], "secret");
    const dialog = el.shadowRoot!.querySelector("wa-dialog")!;
    // The fingerprint waiting for an answer; wa-dialog's own open state
    // trails behind its hide animation
    const asking = () =>
      dialog.querySelector(".fingerprint")!.textContent!.trim();
    const trustCertificate = async () => {
      await waitUntil(() => asking() === fingerprint, "certificate not shown");
      dialog.querySelectorAll("wa-button")[1].click();
      await el.updateComplete;
      expect(asking()).to.equal("");
    };

    let connecting = el.connect();
    await trustCertificate();
    expect(await connecting).to.be.false;

    // Same server, same certificate: straight to the login
    expect(await el.connect()).to.be.false;
    expect(attempts).to.equal(2);
    expect(asking()).to.equal("");

    // A different certificate is a new question
    fingerprint = Array(32).fill("CD").join(":");
    connecting = el.connect();
    await trustCertificate();
    expect(await connecting).to.be.false;
    expect(attempts).to.equal(3);

    // So is a different server address
    await typeInto(el, inputs[0], "https://pve.example:8007");
    connecting = el.connect();
    await trustCertificate();
    expect(await connecting).to.be.false;
    expect(attempts).to.equal(4);
  });

  for (const action of ["cancel", "dismiss", "disconnect"] as const) {
    it(`sends no credentials after certificate ${action}`, async () => {
      const calls: string[] = [];
      mockTauriIpc((cmd) => {
        calls.push(cmd);
        return "AB:".repeat(31) + "AB";
      });
      const { el, inputs } = await renderView();
      await typeInto(el, inputs[0], "https://pve.example:8006");
      await typeInto(el, inputs[2], "secret");
      const connecting = el.connect();
      await settle();
      await el.updateComplete;
      const dialog = el.shadowRoot!.querySelector("wa-dialog")!;
      if (action === "cancel") dialog.querySelector("wa-button")!.click();
      else if (action === "dismiss")
        dialog.dispatchEvent(new Event("wa-after-hide"));
      else el.remove();
      expect(await connecting).to.be.false;
      expect(calls).to.deep.equal(["proxmox_certificate_fingerprint"]);
      expect(wizardState.getState().selections.proxmoxConnected).not.to.be.true;
    });
  }

  it("stops before authentication if the certificate probe fails", async () => {
    const calls: string[] = [];
    mockTauriIpc((cmd) => {
      calls.push(cmd);
      throw new Error("Certificate expired");
    });
    const { el, inputs } = await renderView();
    await typeInto(el, inputs[0], "https://pve.example:8006");
    await typeInto(el, inputs[2], "secret");
    expect(await el.connect()).to.be.false;
    expect(calls).to.deep.equal(["proxmox_certificate_fingerprint"]);
    await el.updateComplete;
    expect(
      el.shadowRoot!.querySelector(".status-description")!.textContent
    ).to.include("Certificate expired");
  });

  it("does not authenticate after removal during the probe or start a duplicate connection", async () => {
    const pending = deferred<string | null>();
    const calls: string[] = [];
    mockTauriIpc((cmd) => {
      calls.push(cmd);
      return pending.promise;
    });
    const { el, inputs } = await renderView();
    await typeInto(el, inputs[0], "https://pve.example:8006");
    await typeInto(el, inputs[2], "secret");
    const connecting = el.connect();
    expect(await el.connect()).to.be.false;
    el.remove();
    pending.resolve(null);
    expect(await connecting).to.be.false;
    expect(calls).to.deep.equal(["proxmox_certificate_fingerprint"]);
  });

  for (const outcome of ["success", "failure"] as const) {
    for (const invalidate of ["detach", "reset", "new flow"] as const) {
      it(`ignores authentication ${outcome} after ${invalidate}`, async () => {
        wizardState.startFlow("proxmox");
        const pending = deferred<unknown>();
        let authenticating = false;
        mockTauriIpc((cmd) => {
          if (cmd === "proxmox_certificate_fingerprint") return null;
          if (cmd === "proxmox_connect") {
            authenticating = true;
            return pending.promise;
          }
          throw new Error(cmd);
        });
        const { el, inputs } = await renderView();
        await typeInto(el, inputs[0], "https://pve.example:8006");
        await typeInto(el, inputs[2], "secret");
        const connecting = el.connect();
        await settle();
        expect(authenticating).to.be.true;

        if (invalidate === "detach") el.remove();
        else if (invalidate === "reset") wizardState.reset();
        else wizardState.startFlow("proxmox");
        const state = wizardState.getState();
        if (outcome === "success") pending.resolve({ ticket: "stale" });
        else pending.reject("Stale authentication error");

        expect(await connecting).to.be.false;
        expect(wizardState.getState()).to.equal(state);
        await el.updateComplete;
        expect(el.shadowRoot!.querySelector(".status-description")).to.be.null;
      });
    }

    it(`ignores old authentication ${outcome} after reconnecting the same view`, async () => {
      const pending = deferred<unknown>();
      const current = deferred<unknown>();
      let attempts = 0;
      mockTauriIpc((cmd) => {
        if (cmd === "proxmox_certificate_fingerprint") return null;
        if (cmd === "proxmox_connect") {
          return ++attempts === 1 ? pending.promise : current.promise;
        }
        throw new Error(cmd);
      });
      const { el, inputs } = await renderView();
      await typeInto(el, inputs[0], "https://pve.example:8006");
      await typeInto(el, inputs[2], "secret");
      const first = el.connect();
      await settle();
      const parent = el.parentElement!;
      el.remove();
      parent.append(el);
      const second = el.connect();
      await settle();
      expect(attempts).to.equal(2);

      if (outcome === "success") pending.resolve({ ticket: "stale" });
      else pending.reject("Stale authentication error");
      expect(await first).to.be.false;
      await el.updateComplete;
      expect(inputs.every((input) => input.disabled)).to.be.true;
      expect(await el.connect()).to.be.false;
      expect(el.shadowRoot!.querySelector(".status-description")).to.be.null;

      current.resolve({ ticket: "current" });
      expect(await second).to.be.true;
      expect(wizardState.getState().selections.proxmoxSession?.ticket).to.equal(
        "current"
      );
    });

    it(`preserves a newer session when old authentication reports ${outcome}`, async () => {
      const pending = deferred<unknown>();
      let attempts = 0;
      mockTauriIpc((cmd) => {
        if (cmd === "proxmox_certificate_fingerprint") return null;
        if (cmd === "proxmox_connect") {
          return ++attempts === 1 ? pending.promise : { ticket: "current" };
        }
        throw new Error(cmd);
      });
      const { el, inputs } = await renderView();
      await typeInto(el, inputs[0], "https://pve.example:8006");
      await typeInto(el, inputs[2], "secret");
      const first = el.connect();
      await settle();
      const parent = el.parentElement!;
      el.remove();
      parent.append(el);
      expect(await el.connect()).to.be.true;
      const state = wizardState.getState();
      if (outcome === "success") pending.resolve({ ticket: "stale" });
      else pending.reject("Stale authentication error");
      expect(await first).to.be.false;
      expect(wizardState.getState()).to.equal(state);
      expect(state.selections.proxmoxConnected).to.be.true;
      expect(state.selections.proxmoxSession?.ticket).to.equal("current");
    });
  }

  for (const url of [
    "https://name:password@pve.example",
    "https://pve.example/api",
    "https://pve.example?secret",
    "https://pve.example#secret",
  ]) {
    it(`rejects a non-origin URL: ${url}`, async () => {
      const { el, inputs } = await renderView();
      await typeInto(el, inputs[0], url);
      await typeInto(el, inputs[2], "secret");
      expect(el.isFormValid()).to.be.false;
      expect(await el.connect()).to.be.false;
    });
  }
});
