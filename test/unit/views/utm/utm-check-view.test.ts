import {
  expect,
  fixture,
  fixtureSync,
  html,
  waitUntil,
} from "@open-wc/testing";
import { wizardStep } from "../../../../src/components/wizard-steps.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/utm/utm-check-view.js";
import type { UtmCheckView } from "../../../../src/views/utm/utm-check-view.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

/** Whether the step lets the user on to Configure VM */
function nextAllowed() {
  return wizardStep("vm", "check")!.ready!(wizardState.getState().selections);
}

function allowButton(el: Element) {
  return [...el.shadowRoot!.querySelectorAll("wa-button")].find((button) =>
    button.textContent!.includes("Allow control of UTM")
  ) as HTMLElement & { loading: boolean };
}

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
    // Found: asking macOS is left, and waits for the user
    expect(nextAllowed()).to.be.false;
    expect(allowButton(el)).to.exist;
  });

  it("asks for Automation only when the user chooses to, and gates Next on it", async () => {
    const automation = deferred<void>();
    const calls: string[] = [];
    mockTauriIpc((cmd) => {
      calls.push(cmd);
      if (cmd === "check_utm_status")
        return {
          installed: true,
          path: "/Applications/UTM.app",
          version: "4.5.0",
        };
      if (cmd === "check_utm_automation") return automation.promise;
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = fixtureSync(html`<utm-check-view></utm-check-view>`);
    await settle();
    // Found UTM: it isn't opened, and macOS doesn't ask over the step yet
    expect(calls).to.deep.equal(["check_utm_status"]);
    expect(el.shadowRoot!.textContent).to.contain(
      "macOS asks for your permission"
    );
    expect(nextAllowed()).to.be.false;

    allowButton(el).click();
    await waitUntil(() => calls.includes("check_utm_automation"));
    await settle();
    // macOS is asking: say what to do, and don't let the user on yet
    expect(el.shadowRoot!.textContent).to.contain(
      "Allow the installer to control UTM"
    );
    expect(nextAllowed()).to.be.false;

    automation.resolve();
    await settle();
    expect(nextAllowed()).to.be.true;
    expect(el.shadowRoot!.textContent).to.contain(
      "Ready to create a Home Assistant virtual machine"
    );
    expect(allowButton(el)).to.equal(undefined);
  });

  it("keeps Next gated on re-entry until the new check succeeds, without asking macOS again", async () => {
    // Back from Configure, where the previous check had allowed Next
    wizardState.setSelections({ utmInstalled: true, utmControlAllowed: true });
    const status = deferred<unknown>();
    mockTauriIpc((cmd) => {
      if (cmd === "check_utm_status") return status.promise;
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = fixtureSync(html`<utm-check-view></utm-check-view>`);
    await settle();
    expect(nextAllowed()).to.be.false;
    status.resolve({
      installed: true,
      path: "/Applications/UTM.app",
      version: "4.5.0",
    });
    await settle();
    expect(nextAllowed()).to.be.true;
    expect(el.shadowRoot!.textContent).to.contain(
      "Ready to create a Home Assistant virtual machine"
    );
    expect(allowButton(el)).to.equal(undefined);
  });

  for (const outcome of ["success", "failure"] as const) {
    it(`ignores a late Automation ${outcome} after the flow restarted`, async () => {
      const automation = deferred<void>();
      let checks = 0;
      mockTauriIpc((cmd) => {
        if (cmd === "check_utm_status")
          return {
            installed: true,
            path: "/Applications/UTM.app",
            version: "4.5.0",
          };
        // A late success shows while the new check still waits; a late
        // failure once the new check has allowed Next
        if (cmd === "check_utm_automation")
          return ++checks === 1
            ? automation.promise
            : outcome === "success"
              ? new Promise(() => {})
              : undefined;
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });
      const old = fixtureSync(html`<utm-check-view></utm-check-view>`);
      await settle();
      allowButton(old).click();
      await waitUntil(() => checks === 1);
      // The user left the step and started the flow again
      old.remove();
      wizardState.startFlow("vm");
      const current = fixtureSync(html`<utm-check-view></utm-check-view>`);
      await settle();
      allowButton(current).click();
      await settle();
      const allowed = outcome === "failure";
      expect(nextAllowed()).to.equal(allowed);

      if (outcome === "success") automation.resolve();
      else
        automation.reject(ipcError("utm", "Not allowed to control UTM", true));
      await settle();
      expect(nextAllowed()).to.equal(allowed);
      expect(current.shadowRoot!.querySelector("[data-focus-alert]")).to.equal(
        null
      );
    });
  }

  it("shows a refused Automation prompt and asks again", async () => {
    let asked = 0;
    mockTauriIpc((cmd) => {
      if (cmd === "check_utm_status")
        return {
          installed: true,
          path: "/Applications/UTM.app",
          version: "4.5.0",
        };
      if (cmd === "check_utm_automation")
        return ++asked === 1
          ? Promise.reject(
              ipcError("utm", "Not allowed to control UTM", true, {
                message_key: "backend.utm.automation_denied",
                message_params: {},
              })
            )
          : undefined;
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = fixtureSync(html`<utm-check-view></utm-check-view>`);
    await settle();
    allowButton(el).click();
    await settle();
    await settle();
    expect(
      el.shadowRoot!.querySelector("[data-focus-alert]")!.textContent
    ).to.contain("Privacy & Security > Automation");
    expect(nextAllowed()).to.be.false;

    const retry = el.shadowRoot!.querySelector("wa-button")!;
    expect(retry.textContent).to.contain("Try again");
    retry.click();
    await settle();
    expect(asked).to.equal(2);
    expect(nextAllowed()).to.be.true;
  });

  it("keeps focus through a check started from the page, and announces its result", async () => {
    const second = deferred<unknown>();
    // The macOS prompt stays up until the user answers it
    const automation = deferred<void>();
    let checks = 0;
    mockTauriIpc((cmd) => {
      if (cmd === "check_utm_automation") return automation.promise;
      expect(cmd).to.equal("check_utm_status");
      return ++checks === 1
        ? { installed: false, path: null, version: null }
        : second.promise;
    });
    const el = await fixture<UtmCheckView>(
      html`<utm-check-view></utm-check-view>`
    );
    await waitUntil(() =>
      el.shadowRoot!.textContent!.includes("not installed")
    );
    const status = el.shadowRoot!.querySelector('[role="status"]')!;

    const installedIt = [...el.shadowRoot!.querySelectorAll("wa-button")].find(
      (button) => button.textContent!.includes("installed UTM")
    ) as HTMLElement & { loading: boolean };
    installedIt.focus();
    installedIt.click();
    await el.updateComplete;

    // Still there, busy, rather than swapped for the spinner
    expect(installedIt.isConnected).to.be.true;
    expect(installedIt.loading).to.be.true;
    expect(el.shadowRoot!.activeElement).to.equal(installedIt);
    // The same region reports the check
    expect(el.shadowRoot!.querySelector('[role="status"]')).to.equal(status);
    expect(status.textContent).to.contain("Checking");
    expect(status.querySelector(".status-loading loading-spinner")).to.exist;

    second.resolve({
      installed: true,
      path: "/Applications/UTM.app",
      version: "4.5.0",
    });
    await waitUntil(() => !installedIt.isConnected);
    await el.updateComplete;

    // Found: the buttons are gone, so focus continues from the result
    let title = status.querySelector(".status-title")!;
    expect(title.textContent).to.contain("installed");
    expect(el.shadowRoot!.activeElement).to.equal(title);

    const allow = allowButton(el);
    allow.focus();
    allow.click();
    await waitUntil(() =>
      status.textContent!.includes("Allow the installer to control UTM")
    );

    // macOS is asking: the button stays, busy
    expect(allow.isConnected).to.be.true;
    expect(allow.loading).to.be.true;
    expect(el.shadowRoot!.activeElement === allow).to.be.true;

    automation.resolve();
    await waitUntil(() => !allow.isConnected);
    await el.updateComplete;

    // Allowed: focus continues from the result again
    title = status.querySelector(".status-title")!;
    expect(title.textContent).to.contain("installed");
    expect(el.shadowRoot!.activeElement === title).to.be.true;
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
    delete bridge.isTauri;
    delete bridge.__TAURI_INTERNALS__;
    wizardState.reset();
  });

  for (const installed of [false, true]) {
    it(`shows ${installed ? "happy" : "sad"} Casita after checking UTM`, async () => {
      bridge.isTauri = true;
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
      expect(
        el.shadowRoot!.querySelector(
          installed ? ".status-success" : ".status-warning"
        )
      ).to.exist;
      if (!installed)
        expect(el.shadowRoot!.textContent).to.include("Download UTM");
    });
  }

  it("explains on an Intel Mac that the option isn't available", async () => {
    bridge.isTauri = true;
    bridge.__TAURI_INTERNALS__ = {
      invoke: () =>
        Promise.reject({
          code: "unsupported_platform",
          message:
            "This installation method is not available on this computer.",
          retryable: false,
          details: {},
        }),
    };
    const el = await fixture<UtmCheckView>(
      html`<utm-check-view></utm-check-view>`
    );
    await waitUntil(
      () => el.shadowRoot!.querySelector("casita-mascot")!.mood !== "loading"
    );

    const text = el.shadowRoot!.textContent!;
    expect(el.shadowRoot!.querySelector("casita-mascot")!.mood).to.equal("sad");
    expect(text).to.include("Not available on this Mac");
    expect(text).to.include("Apple silicon");
    // None of it applies when the option can't run here at all
    expect(el.shadowRoot!.querySelector("inline-notice")).to.equal(null);
    expect(el.shadowRoot!.querySelector("[data-focus-alert]")).to.equal(null);
    expect(text).not.to.include("Error checking UTM");
    expect(text).not.to.include("Try again");
    expect(wizardState.getState().selections.utmInstalled).to.be.false;
  });

  it("uses problem artwork alongside the error and retry control", async () => {
    bridge.isTauri = true;
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
    // Drawn as an error, like the one on Proxmox connect, not as a result
    const error = el.shadowRoot!.querySelector(".status-error")!;
    expect(error.hasAttribute("data-focus-alert")).to.be.true;
    expect(error.querySelector(".status-description")!.textContent).to.include(
      "Mock check failed"
    );
    expect(el.shadowRoot!.querySelector('[role="status"]')!.textContent!.trim())
      .to.be.empty;
    expect(el.shadowRoot!.textContent).to.include("Try again");
  });
});
