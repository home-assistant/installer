import { expect, fixtureSync, html } from "@open-wc/testing";
import type { ProxmoxVmResult } from "../../../../src/api/types.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/proxmox/proxmox-progress-view.js";
import type { ProxmoxProgressView } from "../../../../src/views/proxmox/proxmox-progress-view.js";
import {
  deferred,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

/** The install pipeline's cancellation handle, which is private to the view */
function abortSignalOf(el: ProxmoxProgressView): AbortSignal | undefined {
  return (el as unknown as { _abortController?: AbortController })
    ._abortController?.signal;
}

/**
 * Hold `proxmox_create_vm` open until the test resolves it, instead of
 * running the multi-second browser-only simulation.
 */
function mockCreateVm() {
  const called = deferred<void>();
  const result = deferred<ProxmoxVmResult>();
  mockTauriIpc((cmd) => {
    if (cmd === "proxmox_create_vm") {
      called.resolve();
      return result.promise;
    }
    throw new Error(`Unexpected IPC command: ${cmd}`);
  });
  return { called: called.promise, resolve: result.resolve };
}

/**
 * Mount the view synchronously, so assertions and listeners are in place
 * before the install pipeline's first `await` resolves.
 */
function mount(): ProxmoxProgressView {
  return fixtureSync<ProxmoxProgressView>(html`
    <proxmox-progress-view></proxmox-progress-view>
  `);
}

describe("proxmox-progress-view", () => {
  beforeEach(() => {
    wizardState.startFlow("proxmox");
    wizardState.setSelection("proxmoxSession", {
      server_url: "https://192.168.1.100:8006",
      ticket: "mock-ticket",
      csrf_token: "mock-csrf",
    });
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  it("starts the install when connected", async () => {
    const el = mount();

    expect(abortSignalOf(el), "install did not start").to.exist;
    expect(abortSignalOf(el)!.aborted).to.be.false;
  });

  it("cancels the install pipeline when detached", async () => {
    const el = mount();
    const signal = abortSignalOf(el)!;

    el.remove();

    expect(signal.aborted).to.be.true;
  });

  it("does not touch the wizard or advance it after being detached", async () => {
    const createVm = mockCreateVm();
    const el = mount();
    let completed = false;
    let errored = false;
    el.addEventListener("install-complete", () => {
      completed = true;
    });
    el.addEventListener("install-error", () => {
      errored = true;
    });

    // Detach while the backend call is in flight, then let it succeed
    await createVm.called;
    el.remove();
    createVm.resolve({
      vm_id: 100,
      node: "pve",
      ip_address: "192.168.1.50",
    });
    await settle();

    expect(completed, "install-complete fired after detach").to.be.false;
    expect(errored, "install-error fired after detach").to.be.false;
    const selections = wizardState.getState().selections;
    expect(selections.proxmoxVmResult).to.be.undefined;
    expect(selections.ipAddress).to.be.undefined;
  });

  it("stores the result and advances when the install succeeds", async () => {
    const createVm = mockCreateVm();
    const el = mount();
    let completed = false;
    el.addEventListener("install-complete", () => {
      completed = true;
    });

    await createVm.called;
    createVm.resolve({
      vm_id: 100,
      node: "pve",
      ip_address: "192.168.1.50",
    });
    await settle();

    // The same harness does observe the result while attached, so the
    // detached test above is not passing just because nothing ran
    expect(completed).to.be.true;
    expect(wizardState.getState().selections.ipAddress).to.equal(
      "192.168.1.50"
    );
  });

  it("reports an error without starting when there is no session", async () => {
    wizardState.startFlow("proxmox");

    // The app shell only shows Cancel and Try again after install-error
    let errorEvents = 0;
    const onError = () => errorEvents++;
    document.addEventListener("install-error", onError);

    try {
      const el = mount();
      await el.updateComplete;

      expect(abortSignalOf(el), "install should not have started").to.not.exist;
      expect(el.hasError).to.be.true;
      expect(el.shadowRoot!.textContent).to.contain("No Proxmox session");
      expect(errorEvents).to.equal(1);
    } finally {
      document.removeEventListener("install-error", onError);
    }
  });
});
