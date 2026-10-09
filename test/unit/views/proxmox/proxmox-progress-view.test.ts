import { expect, fixtureSync, html, oneEvent } from "@open-wc/testing";
import type {
  FlashProgress,
  ProxmoxVmResult,
} from "../../../../src/api/types.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/proxmox/proxmox-progress-view.js";
import type { ProxmoxProgressView } from "../../../../src/views/proxmox/proxmox-progress-view.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

/** The install pipeline's cancellation handle, which is private to the view */
function abortSignalOf(el: ProxmoxProgressView): AbortSignal | undefined {
  return (el as unknown as { _abortController?: AbortController })
    ._abortController?.signal;
}

/** What the install view shows inside its shared progress layout */
function progressOf(el: ProxmoxProgressView): ShadowRoot {
  return el.shadowRoot!.querySelector("install-progress")!.shadowRoot!;
}

function errorText(el: ProxmoxProgressView): string {
  return progressOf(el).querySelector(".error-message")!.textContent ?? "";
}

/**
 * Hold `proxmox_create_vm` open until the test resolves it, instead of
 * running the multi-second browser-only simulation. The VM reports its
 * address and Home Assistant answers every readiness check at once.
 */
function mockCreateVm() {
  const called = deferred<void>();
  const result = deferred<ProxmoxVmResult>();
  mockTauriIpc((cmd) => {
    switch (cmd) {
      case "proxmox_create_vm":
        called.resolve();
        return result.promise;
      case "proxmox_get_vm_status":
        return { status: "running", ip_address: "192.168.1.50" };
      case "check_ha_ready":
      case "check_ha_updated":
        return true;
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
    createVm.resolve({ vm_id: 100, node: "pve" });
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
    createVm.resolve({ vm_id: 100, node: "pve" });
    await settle();

    // The same harness does observe the result while attached, so the
    // detached test above is not passing just because nothing ran
    expect(completed).to.be.true;
    expect(wizardState.getState().selections.ipAddress).to.equal(
      "192.168.1.50"
    );
  });

  // A failed creation can hide a VM that was already created, so the view
  // never repeats it in place
  it("renders a creation failure without retrying it in place", async () => {
    let attempts = 0;
    mockTauriIpc((cmd) => {
      expect(cmd).to.equal("proxmox_create_vm");
      attempts++;
      return Promise.reject({
        code: "proxmox_api",
        message: "Storage unavailable",
        retryable: false,
        details: {},
      });
    });
    const el = mount();
    let completed = 0;
    let errors = 0;
    el.addEventListener("install-complete", () => completed++);
    el.addEventListener("install-error", () => errors++);
    await settle();
    expect(errorText(el)).to.contain("account permissions");
    expect(completed).to.equal(0);
    expect(errors).to.equal(1);
    el.retry();
    await settle();
    expect(attempts).to.equal(1);
    expect(el.hasError).to.be.true;
  });

  it("waits for Home Assistant before advancing", async () => {
    const haReady = deferred<boolean>();
    const checked: string[] = [];
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "proxmox_create_vm":
          return { vm_id: 100, node: "pve" };
        case "proxmox_get_vm_status":
          return { status: "running", ip_address: "192.168.1.50" };
        case "check_ha_ready":
          checked.push(cmd);
          return haReady.promise;
        case "check_ha_updated":
          checked.push(cmd);
          return true;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = mount();
    let completed = false;
    el.addEventListener("install-complete", () => {
      completed = true;
    });
    await settle();

    // The VM exists, but Home Assistant has not answered yet
    expect(completed).to.be.false;
    expect(wizardState.getState().selections.proxmoxVmResult).to.exist;
    await el.updateComplete;
    expect(progressOf(el).querySelector("h2")!.textContent).to.equal(
      "Waiting for Home Assistant"
    );

    haReady.resolve(true);
    await oneEvent(el, "install-complete");
    expect(checked).to.deep.equal(["check_ha_ready", "check_ha_updated"]);
  });

  it("resumes a retried install instead of creating a second VM", async () => {
    // What a failed attempt leaves behind once the VM exists
    wizardState.setSelection("proxmoxVmResult", { vm_id: 100, node: "pve" });
    // `proxmox_create_vm` is not handled, so calling it fails the install
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "proxmox_get_vm_status":
          return { status: "running", ip_address: "192.168.1.50" };
        case "check_ha_ready":
        case "check_ha_updated":
          return true;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = mount();
    await oneEvent(el, "install-complete");

    expect(el.hasError).to.be.false;
    expect(wizardState.getState().selections.ipAddress).to.equal(
      "192.168.1.50"
    );
  });

  it("asks the VM for its address again on a retry", async () => {
    // A previous attempt found the VM at an address it no longer has
    wizardState.setSelection("proxmoxVmResult", { vm_id: 100, node: "pve" });
    wizardState.setSelection("ipAddress", "192.168.1.50");

    const askedFor: unknown[] = [];
    const checkedHosts: unknown[] = [];
    mockTauriIpc((cmd, args) => {
      switch (cmd) {
        case "proxmox_get_vm_status":
          askedFor.push(args);
          return { status: "running", ip_address: "192.168.1.100" };
        case "check_ha_ready":
        case "check_ha_updated":
          checkedHosts.push((args as { ipAddress: string }).ipAddress);
          return true;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = mount();
    await oneEvent(el, "install-complete");

    // Asked about the VM the first attempt created
    expect(askedFor).to.have.length(1);
    expect(askedFor[0]).to.include({ node: "pve", vmId: 100 });
    expect(wizardState.getState().selections.ipAddress).to.equal(
      "192.168.1.100"
    );
    expect(checkedHosts).to.not.include("192.168.1.50");
  });

  it("fails when the VM never reports an address, and recovers on retry", async () => {
    // Jump the clock past the 5-minute deadline from inside the first check,
    // instead of waiting it out
    const realNow = Date.now;
    let clockOffset = 0;
    Date.now = () => realNow.call(Date) + clockOffset;

    try {
      const calls: string[] = [];
      let ipAddress: string | null = null;
      mockTauriIpc((cmd) => {
        calls.push(cmd);
        switch (cmd) {
          case "proxmox_create_vm":
            return { vm_id: 100, node: "pve" };
          case "proxmox_get_vm_status":
            if (!ipAddress) clockOffset += 6 * 60 * 1000;
            return { status: "running", ip_address: ipAddress };
          case "check_ha_ready":
          case "check_ha_updated":
            return true;
        }
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });

      const el = mount();
      const failed = await oneEvent(el, "install-error");
      await el.updateComplete;

      expect(failed.detail.retryable).to.be.true;
      expect(errorText(el)).to.contain("did not report an IPv4 address");
      // Not reported as installed, and nothing to check Home Assistant on
      expect(calls).to.not.include("check_ha_ready");
      // The VM is kept, so a retry does not create a second one
      expect(wizardState.getState().selections.proxmoxVmResult).to.exist;

      // The VM comes up on the network, then the user retries
      ipAddress = "192.168.1.100";
      const completed = oneEvent(el, "install-complete");
      el.retry();
      await completed;

      expect(calls.filter((c) => c === "proxmox_create_vm")).to.have.length(1);
      expect(wizardState.getState().selections.ipAddress).to.equal(
        "192.168.1.100"
      );
    } finally {
      Date.now = realNow;
    }
  });

  it("fails when Home Assistant never finishes updating, and recovers on retry", async () => {
    const realNow = Date.now;
    let clockOffset = 0;
    Date.now = () => realNow.call(Date) + clockOffset;

    try {
      const calls: string[] = [];
      let updated = false;
      mockTauriIpc((cmd) => {
        calls.push(cmd);
        switch (cmd) {
          case "proxmox_create_vm":
            return { vm_id: 100, node: "pve" };
          case "proxmox_get_vm_status":
            return { status: "running", ip_address: "192.168.1.100" };
          case "check_ha_ready":
            return true;
          case "check_ha_updated":
            // Past the 60-minute deadline from inside the first check
            if (!updated) clockOffset += 61 * 60 * 1000;
            return updated;
        }
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });

      const el = mount();
      let completed = false;
      el.addEventListener("install-complete", () => {
        completed = true;
      });
      await oneEvent(el, "install-error");
      await el.updateComplete;

      expect(completed).to.be.false;
      expect(errorText(el)).to.contain("http://192.168.1.100");
      expect(wizardState.getState().selections.proxmoxVmResult).to.exist;

      updated = true;
      const done = oneEvent(el, "install-complete");
      el.retry();
      await done;

      expect(calls.filter((c) => c === "proxmox_create_vm")).to.have.length(1);
    } finally {
      Date.now = realNow;
    }
  });

  // Asking again with the same session or the same missing permission fails
  // the same way, so waiting would only hide the cause behind a timeout
  for (const [error, guidance] of [
    [
      ipcError(
        "proxmox_session_expired",
        "Proxmox session expired or invalid. Please reconnect to Proxmox.",
        false
      ),
      "reconnect",
    ],
    [
      ipcError(
        "proxmox_action_required",
        "Access denied. Your Proxmox user may not have permission to see this VM's status.",
        true
      ),
      "permission",
    ],
  ] as const) {
    it(`stops waiting for the address on ${error.code}`, async () => {
      wizardState.setSelection("proxmoxVmResult", { vm_id: 100, node: "pve" });
      let statusCalls = 0;
      const calls: string[] = [];
      mockTauriIpc((cmd) => {
        calls.push(cmd);
        if (cmd === "proxmox_get_vm_status") {
          statusCalls++;
          return Promise.reject(error);
        }
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });

      const el = mount();
      const failed = await oneEvent(el, "install-error");
      await el.updateComplete;

      expect(statusCalls).to.equal(1);
      expect(failed.detail.retryable).to.equal(error.retryable);
      expect(errorText(el)).to.contain(guidance);
      expect(calls).to.not.include("check_ha_ready");
      // The VM stays known, for when the user comes back to it
      expect(wizardState.getState().selections.proxmoxVmResult).to.exist;
    });
  }

  it("keeps waiting for the address through a transient status failure", async () => {
    wizardState.setSelection("proxmoxVmResult", { vm_id: 100, node: "pve" });
    let statusCalls = 0;
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "proxmox_get_vm_status":
          statusCalls++;
          if (statusCalls === 1) {
            return Promise.reject(
              ipcError("proxmox_api", "Proxmox could not complete it", true)
            );
          }
          return { status: "running", ip_address: "192.168.1.100" };
        case "check_ha_ready":
        case "check_ha_updated":
          return true;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = mount();
    await oneEvent(el, "install-complete");

    expect(statusCalls).to.equal(2);
    expect(el.hasError).to.be.false;
  });

  it("shows the step the backend reports", async () => {
    const createVm = deferred<ProxmoxVmResult>();
    let report!: (progress: FlashProgress) => void;
    mockTauriIpc((cmd, args) => {
      if (cmd === "proxmox_create_vm") {
        const { progressChannel } = args as {
          progressChannel: { onmessage: (progress: FlashProgress) => void };
        };
        report = (progress) => progressChannel.onmessage(progress);
        return createVm.promise;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = mount();
    await settle();

    // Each backend stage, with the heading shown for it
    const steps: Array<[FlashProgress["stage"], string]> = [
      ["extracting", "Extracting the image"],
      ["uploading", "Uploading image to Proxmox"],
      ["creating_vm", "Creating virtual machine"],
      ["starting_vm", "Starting Home Assistant OS"],
    ];
    for (const [stage, heading] of steps) {
      report({
        stage,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "",
      });
      await el.updateComplete;
      expect(progressOf(el).querySelector("h2")!.textContent).to.equal(heading);
    }
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
      expect(progressOf(el).textContent).to.contain("No Proxmox session");
      expect(errorEvents).to.equal(1);
    } finally {
      document.removeEventListener("install-error", onError);
    }
  });
});
