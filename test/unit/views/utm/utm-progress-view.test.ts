import {
  aTimeout,
  expect,
  fixtureSync,
  html,
  oneEvent,
} from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/utm/utm-progress-view.js";
import "../../../../src/views/utm/utm-configure-view.js";
import type { UtmProgressView } from "../../../../src/views/utm/utm-progress-view.js";
import {
  deferred,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

/** The install pipeline's cancellation handle, which is private to the view */
function abortSignalOf(el: UtmProgressView): AbortSignal | undefined {
  return (el as unknown as { _abortController?: AbortController })
    ._abortController?.signal;
}

/**
 * Mount the view synchronously, so assertions and listeners are in place
 * before the install pipeline's first `await` resolves.
 */
function mount(): UtmProgressView {
  return fixtureSync<UtmProgressView>(html`
    <utm-progress-view></utm-progress-view>
  `);
}

/** The error shown by the shared progress layout, which renders it in its own shadow root. */
function errorText(view: UtmProgressView) {
  return view
    .shadowRoot!.querySelector("install-progress")!
    .shadowRoot!.querySelector(".error-message")?.textContent;
}

describe("utm-progress-view", () => {
  beforeEach(() => {
    wizardState.startFlow("vm");
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  it("starts the install when connected", async () => {
    const el = mount();

    expect(abortSignalOf(el), "install did not start").to.exist;
    expect(abortSignalOf(el)!.aborted).to.be.false;

    await el.updateComplete;
    expect(
      el
        .shadowRoot!.querySelector("install-progress")!
        .shadowRoot!.querySelector("h2")!.textContent
    ).to.contain("Downloading");
  });

  it("cancels the install pipeline when detached", async () => {
    const el = mount();
    const signal = abortSignalOf(el)!;

    el.remove();

    expect(signal.aborted).to.be.true;
  });

  it("does not touch the wizard or advance it after being detached", async () => {
    // Seed the state a completed attempt would leave behind, so the pipeline
    // skips straight to the polling stages, and answer every check at once:
    // without cancellation it would finish well within the wait below
    wizardState.setSelection("vmId", "existing-vm");
    wizardState.setSelection("utmDiskResized", true);
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "get_utm_vm_status":
          return { status: "started", ip_address: "192.168.1.100" };
        case "check_ha_ready":
        case "check_ha_updated":
          return true;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = mount();
    let completed = false;
    let errored = false;
    el.addEventListener("install-complete", () => {
      completed = true;
    });
    el.addEventListener("install-error", () => {
      errored = true;
    });

    el.remove();
    await aTimeout(50);

    expect(completed, "install-complete fired after detach").to.be.false;
    expect(errored, "install-error fired after detach").to.be.false;
    // The IP the polling stage would have found is never written
    expect(wizardState.getState().selections.ipAddress).to.be.undefined;
  });

  it("resumes a retried install instead of creating a second VM", async () => {
    // What a failed attempt leaves behind once the VM exists
    wizardState.setSelection("vmId", "existing-vm");

    const el = mount();
    await oneEvent(el, "install-complete");

    const selections = wizardState.getState().selections;
    // A second createUtmVm call would have replaced this with a new id
    expect(selections.vmId).to.equal("existing-vm");
    expect(selections.ipAddress).to.equal("192.168.1.100");
    expect(el.hasError).to.be.false;
  });

  it("retains a VM created after detachment and resumes it on reentry", async () => {
    let finishCreate!: (value: string) => void;
    const calls: string[] = [];
    mockTauriIpc((cmd, args) => {
      if (cmd === "discard_utm_image") return undefined;
      calls.push(cmd);
      switch (cmd) {
        case "get_system_info":
          return { cpu_cores: 8, memory_mb: 16384 };
        case "download_utm_image":
          return "/tmp/owned.qcow2";
        case "create_utm_vm":
          return new Promise<string>((resolve) => {
            finishCreate = resolve;
          });
        case "resize_utm_vm_disk":
        case "start_utm_vm":
          expect((args as { vmId: string }).vmId).to.equal("created-vm");
          return undefined;
        case "get_utm_vm_status":
          expect((args as { vmId: string }).vmId).to.equal("created-vm");
          return { status: "stopped", ip_address: "192.168.1.100" };
        case "check_ha_ready":
        case "check_ha_updated":
          return true;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    wizardState.goToStep(3);
    const el = mount();
    const events: string[] = [];
    el.addEventListener("install-complete", () => events.push("complete"));
    el.addEventListener("install-error", () => events.push("error"));
    await aTimeout(20);
    el.remove();
    wizardState.previousStep();
    wizardState.previousStep();
    const configure = fixtureSync(html`
      <utm-configure-view></utm-configure-view>
    `);
    await aTimeout(20);
    configure.remove();
    wizardState.setSelection("utmInstalled", true);
    finishCreate("created-vm");
    await aTimeout(20);

    expect(wizardState.getState().selections.vmId).to.equal("created-vm");
    expect(wizardState.getState().selections.utmDiskResized).to.be.undefined;
    expect(calls).to.deep.equal([
      "download_utm_image",
      "create_utm_vm",
      "get_system_info",
    ]);
    expect(events).to.deep.equal([]);

    wizardState.goToStep(3);
    await oneEvent(mount(), "install-complete");
    expect(calls.filter((cmd) => cmd === "create_utm_vm")).to.have.length(1);
    expect(calls.filter((cmd) => cmd === "download_utm_image")).to.have.length(
      1
    );
    expect(calls).to.include("resize_utm_vm_disk");
    expect(calls).to.include("start_utm_vm");
    expect(wizardState.getState().selections.ipAddress).to.equal(
      "192.168.1.100"
    );
  });

  for (const change of ["reset", "new flow", "new VM", "configuration"]) {
    it(`ignores a detached creation result after ${change}`, async () => {
      let finishCreate!: (value: string) => void;
      const calls: string[] = [];
      mockTauriIpc((cmd) => {
        if (cmd === "discard_utm_image") return undefined;
        calls.push(cmd);
        if (cmd === "download_utm_image") return "/tmp/owned.qcow2";
        if (cmd === "create_utm_vm") {
          return new Promise<string>((resolve) => {
            finishCreate = resolve;
          });
        }
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });
      const el = mount();
      const events: string[] = [];
      el.addEventListener("install-complete", () => events.push("complete"));
      el.addEventListener("install-error", () => events.push("error"));
      await aTimeout(20);
      el.remove();
      if (change === "reset") wizardState.reset();
      if (change === "new flow") wizardState.startFlow("vm");
      if (change === "new VM") wizardState.setSelection("vmId", "newer-vm");
      if (change === "configuration") wizardState.setSelection("cpuCores", 8);
      const currentState = wizardState.getState();
      finishCreate("old-vm");
      await aTimeout(20);

      expect(wizardState.getState()).to.deep.equal({
        ...currentState,
        selections: {
          ...currentState.selections,
          ...(currentState.selections.utmCreation
            ? { utmCreation: undefined }
            : {}),
          ...(change === "configuration"
            ? { utmSupersededVmId: "old-vm" }
            : {}),
        },
      });
      expect(calls).to.deep.equal(["download_utm_image", "create_utm_vm"]);
      expect(events).to.deep.equal([]);
    });
  }

  for (const reuseElement of [false, true]) {
    it(`awaits pending creation on ${reuseElement ? "the same element" : "a replacement view"} before resizing or starting`, async () => {
      const creation = deferred<string>();
      const calls: string[] = [];
      const discarded: string[] = [];
      let started = false;
      mockTauriIpc((cmd, args) => {
        if (cmd === "discard_utm_image") {
          discarded.push((args as { imagePath: string }).imagePath);
          return undefined;
        }
        calls.push(cmd);
        if (cmd === "download_utm_image") return "/tmp/haos.qcow2";
        if (cmd === "create_utm_vm") return creation.promise;
        if (cmd === "resize_utm_vm_disk" || cmd === "start_utm_vm") {
          expect(wizardState.getState().selections.vmId).to.equal("shared-id");
          if (cmd === "start_utm_vm") started = true;
          return undefined;
        }
        if (cmd === "get_utm_vm_status") {
          return {
            status: started ? "started" : "stopped",
            ip_address: "192.168.1.100",
          };
        }
        if (cmd === "check_ha_ready" || cmd === "check_ha_updated") return true;
        throw new Error(cmd);
      });
      const first = mount();
      await settle();
      const parent = first.parentElement!;
      first.remove();
      const next = reuseElement ? first : mount();
      if (reuseElement) parent.append(next);
      const complete = oneEvent(next, "install-complete");
      await settle();
      expect(calls).to.deep.equal(["download_utm_image", "create_utm_vm"]);
      expect(discarded).to.deep.equal([]);
      creation.resolve("shared-id");
      await complete;
      expect(discarded).to.deep.equal(["/tmp/haos.qcow2"]);
      expect(calls.filter((cmd) => cmd === "create_utm_vm")).to.have.length(1);
      expect(
        calls.filter((cmd) => cmd === "resize_utm_vm_disk")
      ).to.have.length(1);
      expect(calls.filter((cmd) => cmd === "start_utm_vm")).to.have.length(1);
      expect(wizardState.getState().selections.utmCreation).to.be.undefined;
      expect(wizardState.getState().selections.vmId).to.equal("shared-id");
    });
  }

  it("reports a shared creation failure only to the reentered view and permits retry", async () => {
    const creation = deferred<string>();
    let creates = 0;
    mockTauriIpc((cmd) => {
      if (cmd === "discard_utm_image") return undefined;
      if (cmd === "download_utm_image") return "/tmp/haos.qcow2";
      if (cmd === "create_utm_vm")
        return ++creates === 1 ? creation.promise : "retry-id";
      if (cmd === "resize_utm_vm_disk") return undefined;
      if (cmd === "get_utm_vm_status")
        return { status: "started", ip_address: "192.168.1.100" };
      if (cmd === "check_ha_ready" || cmd === "check_ha_updated") return true;
      throw new Error(cmd);
    });
    const first = mount();
    let oldError = false;
    first.addEventListener("install-error", () => (oldError = true));
    await settle();
    first.remove();
    const next = mount();
    const error = oneEvent(next, "install-error");
    await settle();
    expect(creates).to.equal(1);
    creation.reject(new Error("Import failed"));
    await error;
    expect(oldError).to.be.false;
    expect(next.hasError).to.be.true;
    expect(wizardState.getState().selections.utmCreation).to.be.undefined;
    const complete = oneEvent(next, "install-complete");
    next.retry();
    await complete;
    expect(creates).to.equal(2);
    expect(wizardState.getState().selections.vmId).to.equal("retry-id");
  });

  for (const outcome of ["success", "error"]) {
    it(`does not let an old flow's late ${outcome} clear a new pending creation`, async () => {
      const oldCreation = deferred<string>();
      const newCreation = deferred<string>();
      let creates = 0;
      let downloads = 0;
      const discarded: string[] = [];
      mockTauriIpc((cmd, args) => {
        if (cmd === "discard_utm_image") {
          discarded.push((args as { imagePath: string }).imagePath);
          return undefined;
        }
        if (cmd === "download_utm_image")
          return `/tmp/flow-${++downloads}.qcow2`;
        if (cmd === "create_utm_vm")
          return ++creates === 1 ? oldCreation.promise : newCreation.promise;
        if (cmd === "resize_utm_vm_disk") return undefined;
        if (cmd === "get_utm_vm_status")
          return { status: "started", ip_address: "192.168.1.100" };
        if (cmd === "check_ha_ready" || cmd === "check_ha_updated") return true;
        throw new Error(cmd);
      });
      const first = mount();
      let oldEvent = false;
      first.addEventListener("install-error", () => (oldEvent = true));
      first.addEventListener("install-complete", () => (oldEvent = true));
      await settle();
      wizardState.reset();
      wizardState.startFlow("vm");
      const next = mount();
      await settle();
      const pending = wizardState.getState().selections.utmCreation;
      expect(creates).to.equal(2);
      if (outcome === "success") oldCreation.resolve("old-id");
      else oldCreation.reject(new Error("Old import failed"));
      await settle();
      expect(oldEvent).to.be.false;
      expect(wizardState.getState().selections.vmId).to.be.undefined;
      expect(wizardState.getState().selections.utmSupersededVmId).to.be
        .undefined;
      expect(wizardState.getState().selections.utmCreation).to.equal(pending);
      expect(discarded).to.deep.equal(["/tmp/flow-1.qcow2"]);
      const complete = oneEvent(next, "install-complete");
      newCreation.resolve("new-id");
      await complete;
      expect(wizardState.getState().selections.vmId).to.equal("new-id");
      expect(discarded).to.deep.equal([
        "/tmp/flow-1.qcow2",
        "/tmp/flow-2.qcow2",
      ]);
    });
  }

  it("does not launch another pending creation when VM settings changed", async () => {
    const creation = deferred<string>();
    let creates = 0;
    let downloads = 0;
    mockTauriIpc((cmd) => {
      if (cmd === "discard_utm_image") return undefined;
      if (cmd === "download_utm_image")
        return `/tmp/attempt-${++downloads}.qcow2`;
      if (cmd === "create_utm_vm") {
        creates++;
        return creation.promise;
      }
      throw new Error(cmd);
    });
    const first = mount();
    await settle();
    first.remove();
    wizardState.setSelection("cpuCores", 8);
    const next = mount();
    await oneEvent(next, "install-error");
    expect(creates).to.equal(1);
    expect(downloads).to.equal(1);
    creation.resolve("old-id");
    await settle();
    expect(wizardState.getState().selections.vmId).to.be.undefined;
    expect(wizardState.getState().selections.utmCreation).to.be.undefined;
  });

  it("warns on reentry after detached creation completed with changed settings", async () => {
    const creation = deferred<string>();
    const calls: string[] = [];
    mockTauriIpc((cmd, args) => {
      calls.push(cmd);
      if (cmd === "download_utm_image") return "/tmp/superseded.qcow2";
      if (cmd === "create_utm_vm") return creation.promise;
      if (cmd === "discard_utm_image") {
        expect((args as { imagePath: string }).imagePath).to.equal(
          "/tmp/superseded.qcow2"
        );
        return undefined;
      }
      throw new Error(cmd);
    });
    const first = mount();
    await settle();
    first.remove();
    wizardState.setSelection("cpuCores", 8);
    creation.resolve("superseded-id");
    await settle();
    expect(wizardState.getState().selections.vmId).to.be.undefined;
    expect(wizardState.getState().selections.utmCreation).to.be.undefined;
    expect(wizardState.getState().selections.utmSupersededVmId).to.equal(
      "superseded-id"
    );

    const next = mount();
    await next.updateComplete;
    expect(next.hasError).to.be.true;
    expect(errorText(next)).to.contain("already created with earlier settings");
    next.retry();
    await next.updateComplete;
    expect(next.hasError).to.be.true;
    expect(calls).to.deep.equal([
      "download_utm_image",
      "create_utm_vm",
      "discard_utm_image",
    ]);
    wizardState.reset();
    expect(wizardState.getState().selections.utmSupersededVmId).to.be.undefined;
  });

  for (const change of ["configuration", "new VM"]) {
    it(`reports an attached creation result superseded by ${change}`, async () => {
      let finishCreate!: (value: string) => void;
      const calls: string[] = [];
      mockTauriIpc((cmd) => {
        if (cmd === "discard_utm_image") return undefined;
        calls.push(cmd);
        if (cmd === "download_utm_image") return "/tmp/haos.qcow2";
        if (cmd === "create_utm_vm") {
          return new Promise<string>((resolve) => {
            finishCreate = resolve;
          });
        }
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });
      const el = mount();
      await aTimeout(20);
      if (change === "configuration") wizardState.setSelection("cpuCores", 8);
      if (change === "new VM") wizardState.setSelection("vmId", "newer-vm");
      const error = oneEvent(el, "install-error");
      finishCreate("old-vm");
      await error;
      await el.updateComplete;
      expect(el.hasError).to.be.true;
      expect(errorText(el)).to.contain("Check UTM before trying again");
      expect(wizardState.getState().selections.vmId).to.equal(
        change === "new VM" ? "newer-vm" : undefined
      );
      expect(calls).to.deep.equal(["download_utm_image", "create_utm_vm"]);
    });
  }

  it("retries a failed disk resize instead of starting an undersized VM", async () => {
    const calls: string[] = [];
    let resizeAttempts = 0;
    mockTauriIpc((cmd) => {
      if (cmd === "discard_utm_image") return undefined;
      calls.push(cmd);
      switch (cmd) {
        case "download_utm_image":
          return "/tmp/owned.qcow2";
        case "create_utm_vm":
          return "new-vm";
        case "resize_utm_vm_disk":
          resizeAttempts++;
          if (resizeAttempts === 1) throw new Error("resize failed");
          return undefined;
        case "get_utm_vm_status":
          return { status: "started", ip_address: "192.168.1.100" };
        case "check_ha_ready":
        case "check_ha_updated":
          return true;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = mount();
    await oneEvent(el, "install-error");

    // The VM exists, but its disk was never resized
    let selections = wizardState.getState().selections;
    expect(selections.vmId).to.equal("new-vm");
    expect(selections.utmDiskResized).to.not.be.true;
    expect(calls, "VM started with an unresized disk").to.not.include(
      "get_utm_vm_status"
    );

    const completed = oneEvent(el, "install-complete");
    el.retry();
    await completed;

    selections = wizardState.getState().selections;
    expect(selections.utmDiskResized).to.be.true;
    // The retry resized the existing VM rather than creating another one
    expect(calls.filter((c) => c === "create_utm_vm")).to.have.length(1);
    expect(resizeAttempts).to.equal(2);
  });

  it("shows Automation settings advice from a Tauri string rejection", async () => {
    const message =
      "UTM error: Home Assistant Installer is not allowed to control UTM. Open System Settings > Privacy & Security > Automation, enable UTM under Home Assistant Installer, then try again.";
    mockTauriIpc(() => Promise.reject(message));

    const el = mount();
    await oneEvent(el, "install-error");
    await el.updateComplete;

    expect(el.hasError).to.be.true;
    expect(
      el
        .shadowRoot!.querySelector("install-progress")!
        .shadowRoot!.querySelector(".error-message")!.textContent
    ).to.equal(message);
    expect(wizardState.getState().selections.vmId).to.be.undefined;
  });

  for (const rejection of [undefined, {}, "", "   "]) {
    it(`shows a fallback for an unusable rejection: ${JSON.stringify(rejection)}`, async () => {
      mockTauriIpc(() => Promise.reject(rejection));

      const el = mount();
      await oneEvent(el, "install-error");
      await el.updateComplete;

      expect(
        el
          .shadowRoot!.querySelector("install-progress")!
          .shadowRoot!.querySelector(".error-message")!.textContent
      ).to.contain("Failed to create virtual machine");
    });
  }

  it("asks the VM for its address again on a retry", async () => {
    // A previous attempt found the VM at an address it no longer has
    wizardState.setSelection("vmId", "existing-vm");
    wizardState.setSelection("utmDiskResized", true);
    wizardState.setSelection("ipAddress", "192.168.1.50");

    const checkedHosts: unknown[] = [];
    mockTauriIpc((cmd, args) => {
      switch (cmd) {
        case "get_utm_vm_status":
          return { status: "started", ip_address: "192.168.1.100" };
        case "check_ha_ready":
        case "check_ha_updated":
          checkedHosts.push((args as { ipAddress: string }).ipAddress);
          return true;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = mount();
    await oneEvent(el, "install-complete");

    expect(wizardState.getState().selections.ipAddress).to.equal(
      "192.168.1.100"
    );
    expect(checkedHosts).to.not.include("192.168.1.50");
  });

  it("reports an IP timeout instead of completing without readiness checks", async () => {
    wizardState.setSelection("vmId", "existing-vm");
    wizardState.setSelection("utmDiskResized", true);
    wizardState.setSelection("ipAddress", "192.168.1.50");
    const realNow = Date.now;
    let statusCalls = 0;
    const calls: string[] = [];
    mockTauriIpc((cmd) => {
      if (cmd === "discard_utm_image") return undefined;
      calls.push(cmd);
      if (cmd === "get_utm_vm_status") {
        if (++statusCalls === 2) {
          Date.now = () => realNow() + 5 * 60 * 1000 + 1;
        }
        return { status: "started", ip_address: null };
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = mount();
    let completed = false;
    el.addEventListener("install-complete", () => (completed = true));
    try {
      await oneEvent(el, "install-error");
    } finally {
      Date.now = realNow;
    }
    await el.updateComplete;
    expect(completed).to.be.false;
    expect(errorText(el)).to.contain("did not report an IPv4 address");
    expect(wizardState.getState().selections.ipAddress).to.be.undefined;
    expect(calls).to.not.include("check_ha_ready");
    expect(calls).to.not.include("check_ha_updated");
  });

  for (const status of ["starting", "resuming"]) {
    it(`does not start a VM that is already ${status}`, async () => {
      wizardState.setSelection("vmId", "existing-vm");
      wizardState.setSelection("utmDiskResized", true);
      const calls: string[] = [];
      mockTauriIpc((cmd) => {
        if (cmd === "discard_utm_image") return undefined;
        calls.push(cmd);
        if (cmd === "get_utm_vm_status") {
          return { status, ip_address: "192.168.1.100" };
        }
        if (cmd === "check_ha_ready" || cmd === "check_ha_updated") return true;
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });
      await oneEvent(mount(), "install-complete");
      expect(calls).to.not.include("start_utm_vm");
    });
  }

  it("keeps the actual VM ID when startup fails and retries that VM", async () => {
    let starts = 0;
    let creates = 0;
    mockTauriIpc((cmd, args) => {
      switch (cmd) {
        case "download_utm_image":
          return "/tmp/owned.qcow2";
        case "resize_utm_vm_disk":
          return undefined;
        case "create_utm_vm":
          creates++;
          expect(
            (args as { config: { auto_start: boolean } }).config.auto_start
          ).to.be.false;
          return "unique-utm-id";
        case "get_utm_vm_status":
          expect((args as { vmId: string }).vmId).to.equal("unique-utm-id");
          return starts < 2
            ? { status: "stopped", ip_address: null }
            : { status: "started", ip_address: "192.168.1.100" };
        case "start_utm_vm":
          expect((args as { vmId: string }).vmId).to.equal("unique-utm-id");
          expect(wizardState.getState().selections.vmId).to.equal(
            "unique-utm-id"
          );
          if (++starts === 1) throw new Error("Start failed");
          return undefined;
        case "check_ha_ready":
        case "check_ha_updated":
          return true;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = mount();
    await oneEvent(el, "install-error");
    expect(wizardState.getState().selections.vmId).to.equal("unique-utm-id");
    const completed = oneEvent(el, "install-complete");
    el.retry();
    await completed;
    expect(creates).to.equal(1);
    expect(starts).to.equal(2);
  });

  it("releases a download which finishes after cancellation", async () => {
    let finishDownload!: (value: string) => void;
    const released: string[] = [];
    mockTauriIpc((cmd, args) => {
      if (cmd === "download_utm_image") {
        return new Promise<string>((resolve) => {
          finishDownload = resolve;
        });
      }
      if (cmd === "discard_utm_image") {
        released.push((args as { imagePath: string }).imagePath);
        return;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = mount();
    el.remove();
    finishDownload("/tmp/cancelled.qcow2");
    await aTimeout(20);
    expect(released).to.deep.equal(["/tmp/cancelled.qcow2"]);
    expect(wizardState.getState().selections.vmId).to.be.undefined;
  });

  it("shows the retained-source warning from a string import rejection", async () => {
    const warning =
      "UTM may still be importing the image: timed out. Source retained at " +
      "/tmp/hai-download-retained. Check UTM before retrying. Remove the " +
      "source directory manually only after confirming UTM has finished or " +
      "stopped importing.";
    mockTauriIpc((cmd) => {
      if (cmd === "download_utm_image")
        return "/tmp/hai-download-retained/disk.qcow2";
      if (cmd === "create_utm_vm") return Promise.reject(warning);
      if (cmd === "discard_utm_image") return undefined;
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = mount();
    await oneEvent(el, "install-error");
    await el.updateComplete;

    expect(el.hasError).to.be.true;
    expect(
      el
        .shadowRoot!.querySelector("install-progress")!
        .shadowRoot!.querySelector(".error-message")!.textContent
    ).to.contain(warning);
    expect(wizardState.getState().selections.vmId).to.be.undefined;
  });

  it("releases a failed import and downloads a fresh image on retry", async () => {
    let downloads = 0;
    const released: string[] = [];
    mockTauriIpc((cmd, args) => {
      if (cmd === "download_utm_image")
        return `/tmp/attempt-${++downloads}.qcow2`;
      if (cmd === "create_utm_vm") throw new Error("import failed");
      if (cmd === "discard_utm_image") {
        released.push((args as { imagePath: string }).imagePath);
        throw new Error("cleanup failed");
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = mount();
    await oneEvent(el, "install-error");
    await aTimeout(20);
    const failedAgain = oneEvent(el, "install-error");
    el.retry();
    await failedAgain;
    await aTimeout(20);
    expect(released).to.deep.equal([
      "/tmp/attempt-1.qcow2",
      "/tmp/attempt-2.qcow2",
    ]);
    await el.updateComplete;
    expect(
      el
        .shadowRoot!.querySelector("install-progress")!
        .shadowRoot!.querySelector(".error-message")!.textContent
    ).to.contain("import failed");
  });
});
