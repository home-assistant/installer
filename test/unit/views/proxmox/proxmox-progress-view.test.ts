import {
  expect,
  fixtureSync,
  html,
  oneEvent,
  waitUntil,
} from "@open-wc/testing";
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

  it("leaves a new flow alone when one starts while it is still shown", async () => {
    const createVm = mockCreateVm();
    const el = mount();
    const events: string[] = [];
    el.addEventListener("install-complete", () => events.push("complete"));
    el.addEventListener("install-error", () => events.push("error"));

    await createVm.called;
    const signal = abortSignalOf(el)!;
    wizardState.startFlow("proxmox");
    expect(signal.aborted).to.be.true;
    createVm.resolve({ vm_id: 100, node: "pve" });
    await settle();

    expect(events).to.deep.equal([]);
    // The VM belongs to the flow that made it
    const selections = wizardState.getState().selections;
    expect(selections.proxmoxVmResult).to.be.undefined;
    expect(selections.ipAddress).to.be.undefined;
    el.remove();
  });

  it("starts from the wizard state as it is when attached again", async () => {
    let creates = 0;
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "proxmox_create_vm":
          creates++;
          return new Promise(() => {});
        case "proxmox_get_vm_status":
          return { status: "running", ip_address: "192.168.1.50" };
        case "check_ha_ready":
        case "check_ha_updated":
          return true;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = mount();
    await settle();
    const parent = el.parentElement!;
    el.remove();

    // Made meanwhile, so attaching again waits for it
    wizardState.setSelection("proxmoxVmResult", { vm_id: 100, node: "pve" });
    let completed = false;
    el.addEventListener("install-complete", () => (completed = true));
    parent.append(el);
    await waitUntil(() => completed || creates > 1, "never went on");

    expect(creates).to.equal(1);
    expect(completed).to.be.true;
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
          case "get_ha_setup_status":
            return null;
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

  it("shows the Core download and what holds it up while Home Assistant installs", async () => {
    wizardState.setSelection("proxmoxVmResult", { vm_id: 100, node: "pve" });
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "proxmox_get_vm_status":
          return { status: "running", ip_address: "192.168.1.100" };
        case "check_ha_ready":
          return true;
        case "check_ha_updated":
          return false;
        case "get_ha_setup_status":
          return {
            core_install_progress: 87.6,
            supervisor_update_progress: null,
            problems: ["free_space"],
          };
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = mount();
    await el.updateComplete;
    const layout = el.shadowRoot!.querySelector("install-progress")!;

    await waitUntil(
      () => layout.stage === "updating" && layout.progress === 88,
      "never showed the Core download"
    );
    expect(layout.measurable).to.be.true;
    expect(layout.indeterminate).to.be.false;
    await waitUntil(
      () =>
        progressOf(el)
          .querySelector(".warning")!
          .textContent!.includes("running out of disk space"),
      "never showed the problem",
      { timeout: 3000 }
    );
    expect(el.hasError).to.be.false;
    el.remove();
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
      "Reconnect to Proxmox",
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
      // Only a new login gets past an expired session
      const reconnect = error.code === "proxmox_session_expired";
      expect(failed.detail.reconnect).to.equal(reconnect);
      const selections = wizardState.getState().selections;
      expect(!!selections.proxmoxSession).to.equal(!reconnect);
      expect(!!selections.proxmoxPreviousServer).to.equal(reconnect);
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

  // Before the VM is created, logging in again can start over safely. Once
  // it is being created, it may exist half way, unknown to the installer.
  for (const [stage, reconnect] of [
    ["uploading", true],
    ["creating_vm", false],
    ["starting_vm", false],
  ] as const) {
    it(`${reconnect ? "offers" : "does not offer"} Reconnect when the session expires while ${stage}`, async () => {
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
      report({
        stage,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "",
      });
      const failed = oneEvent(el, "install-error");
      createVm.reject(
        ipcError("proxmox_session_expired", "Proxmox session expired.")
      );
      expect((await failed).detail.reconnect).to.equal(reconnect);
      await el.updateComplete;

      const selections = wizardState.getState().selections;
      expect(!!selections.proxmoxSession).to.equal(!reconnect);
      expect(errorText(el)).to.contain(
        reconnect ? "Reconnect to Proxmox" : "Check it in Proxmox"
      );
    });
  }

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

  it("shows the backend's progress in whole percent", async () => {
    let report!: (progress: FlashProgress) => void;
    mockTauriIpc((cmd, args) => {
      if (cmd === "proxmox_create_vm") {
        const { progressChannel } = args as {
          progressChannel: { onmessage: (progress: FlashProgress) => void };
        };
        report = (progress) => progressChannel.onmessage(progress);
        return new Promise(() => {});
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = mount();
    await settle();
    report({
      stage: "uploading",
      progress: 42.4,
      bytes_processed: 42_400,
      total_bytes: 100_000,
      message: "",
    });
    await el.updateComplete;
    const layout = el.shadowRoot!.querySelector("install-progress")!;
    await layout.updateComplete;

    expect(layout.progress).to.equal(42);
    expect(progressOf(el).querySelector(".percentage")!.textContent).to.equal(
      "42%"
    );
  });

  it("keeps no empty progress details while it waits", async () => {
    wizardState.setSelection("proxmoxVmResult", { vm_id: 100, node: "pve" });
    mockTauriIpc((cmd) => {
      // The VM has no address yet
      if (cmd === "proxmox_get_vm_status") return new Promise(() => {});
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = mount();
    await el.updateComplete;
    const layout = el.shadowRoot!.querySelector("install-progress")!;
    await waitUntil(() => layout.stage === "waiting");
    await layout.updateComplete;

    expect(layout.indeterminate).to.be.true;
    expect(!!progressOf(el).querySelector("progress-bar")).to.be.true;
    expect(!!progressOf(el).querySelector(".progress-details")).to.be.false;
    el.remove();
  });

  describe("stop", () => {
    const CANCELLED = {
      code: "cancelled",
      message: "Installation was cancelled.",
      retryable: true,
      details: {},
    };

    /**
     * Hold `proxmox_create_vm` open, report its stages on demand, and record
     * every stop request with the attempt it names.
     */
    function mockStoppableInstall({ stopFails = false } = {}) {
      const createVm = deferred<ProxmoxVmResult>();
      const created = deferred<void>();
      const stops: string[] = [];
      let attempt = "";
      let report!: (stage: FlashProgress["stage"]) => void;
      mockTauriIpc((cmd, args) => {
        switch (cmd) {
          case "proxmox_create_vm": {
            const call = args as {
              attempt: string;
              progressChannel: { onmessage: (progress: FlashProgress) => void };
            };
            attempt = call.attempt;
            report = (stage) =>
              call.progressChannel.onmessage({
                stage,
                progress: 0,
                bytes_processed: 0,
                total_bytes: 0,
                message: "",
              });
            created.resolve();
            return createVm.promise;
          }
          case "cancel_vm_install":
            stops.push((args as { attempt: string }).attempt);
            if (stopFails) throw new Error("IPC unavailable");
            return undefined;
          case "proxmox_get_vm_status":
            return { status: "running", ip_address: "192.168.1.50" };
          case "check_ha_ready":
          case "check_ha_updated":
            return true;
        }
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });
      return {
        createVm,
        created: created.promise,
        stops,
        attempt: () => attempt,
        report: (stage: FlashProgress["stage"]) => report(stage),
      };
    }

    function stageTitle(el: ProxmoxProgressView): string {
      return el.shadowRoot!.querySelector("install-progress")!.stageTitle;
    }

    it("stops an install before the VM exists, and says nothing was created", async () => {
      const install = mockStoppableInstall();
      const el = mount();
      const reported: boolean[] = [];
      el.addEventListener("install-stoppable", (event) => {
        reported.push((event as CustomEvent).detail.stoppable);
      });
      await install.created;
      install.report("uploading");
      await el.updateComplete;
      expect(el.stoppable).to.be.true;

      el.stop();
      await settle();

      expect(install.stops).to.deep.equal([install.attempt()]);
      expect(el.stoppable, "a second stop has nothing to add").to.be.false;
      expect(stageTitle(el)).to.equal("Stopping");
      // The thinking cloud adds the ellipsis to the stage title
      await el.shadowRoot!.querySelector("install-progress")!.updateComplete;
      expect(
        progressOf(el).querySelector(".cloud-text")!.textContent!.trim()
      ).to.equal("Stopping...");

      const failed = oneEvent(el, "install-error");
      install.createVm.reject(CANCELLED);
      expect((await failed).detail.retryable).to.be.true;
      await el.updateComplete;
      expect(errorText(el)).to.equal(
        "Installation stopped. Nothing was created on Proxmox."
      );
      expect(reported).to.deep.equal([true, false]);
    });

    it("cannot stop once the VM is being created", async () => {
      const install = mockStoppableInstall();
      const el = mount();
      await install.created;

      install.report("creating_vm");
      await el.updateComplete;
      el.stop();

      expect(el.stoppable).to.be.false;
      expect(install.stops).to.deep.equal([]);
    });

    it("goes on when the VM got created before the stop landed", async () => {
      const install = mockStoppableInstall();
      const el = mount();
      await install.created;
      el.stop();

      const completed = oneEvent(el, "install-complete");
      install.createVm.resolve({ vm_id: 100, node: "pve" });
      await completed;

      expect(el.hasError).to.be.false;
      expect(stageTitle(el)).to.not.equal("Stopping");
    });

    it("offers the stop again when the request fails", async () => {
      const install = mockStoppableInstall({ stopFails: true });
      const el = mount();
      await install.created;

      el.stop();
      await settle();

      expect(install.stops).to.have.length(1);
      expect(el.stoppable).to.be.true;
      expect(stageTitle(el)).to.not.equal("Stopping");
    });
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
