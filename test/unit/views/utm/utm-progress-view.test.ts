import {
  aTimeout,
  expect,
  fixtureSync,
  html,
  oneEvent,
  waitUntil,
} from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/utm/utm-progress-view.js";
import "../../../../src/views/utm/utm-configure-view.js";
import type { UtmProgressView } from "../../../../src/views/utm/utm-progress-view.js";
import {
  deferred,
  ipcError,
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

  // UTM answering with an error answers the same way next time, so waiting
  // would only hide the cause behind a timeout
  for (const [error, guidance] of [
    [
      ipcError(
        "utm",
        "Home Assistant Installer is not allowed to control UTM. Open System Settings > Privacy & Security > Automation, enable UTM under Home Assistant Installer, then try again.",
        true
      ),
      "Automation",
    ],
    [
      ipcError(
        "unsupported_platform",
        "This installation method is not available on this computer.",
        false
      ),
      "not available",
    ],
  ] as const) {
    it(`stops waiting for the address on ${error.code}`, async () => {
      wizardState.setSelection("vmId", "existing-vm");
      let statusCalls = 0;
      const calls: string[] = [];
      mockTauriIpc((cmd) => {
        calls.push(cmd);
        if (cmd === "get_utm_vm_status") {
          statusCalls++;
          // The first check only decides whether to start the VM
          if (statusCalls === 1) return { status: "started", ip_address: null };
          return Promise.reject(error);
        }
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });

      const el = mount();
      await oneEvent(el, "install-error");
      await el.updateComplete;

      expect(statusCalls).to.equal(2);
      expect(errorText(el)).to.contain(guidance);
      expect(calls).to.not.include("check_ha_ready");
    });
  }

  it("keeps waiting for the address when UTM doesn't answer", async () => {
    wizardState.setSelection("vmId", "existing-vm");
    let statusCalls = 0;
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "get_utm_vm_status":
          statusCalls++;
          // The first check only decides whether to start the VM
          if (statusCalls === 1) return { status: "started", ip_address: null };
          if (statusCalls === 2) {
            return Promise.reject(
              ipcError(
                "utm_operation_uncertain",
                "UTM operation outcome is unknown: AppleEvent timed out. (-1712)",
                false
              )
            );
          }
          return { status: "started", ip_address: "192.168.1.100" };
        case "check_ha_ready":
        case "check_ha_updated":
          return true;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = mount();
    await oneEvent(el, "install-complete");

    expect(statusCalls).to.equal(3);
    expect(el.hasError).to.be.false;
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
    it(`awaits pending creation on ${reuseElement ? "the same element" : "a replacement view"} before starting`, async () => {
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
        if (cmd === "start_utm_vm") {
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
    creation.reject(ipcError("utm", "Import failed", true));
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

  it("hands the chosen disk size to VM creation", async () => {
    wizardState.setSelection("diskSizeGb", 128);
    let diskSizeGb: number | undefined;
    mockTauriIpc((cmd, args) => {
      switch (cmd) {
        case "discard_utm_image":
          return undefined;
        case "download_utm_image":
          return "/tmp/owned.qcow2";
        case "create_utm_vm":
          diskSizeGb = (args as { config: { disk_size_gb: number } }).config
            .disk_size_gb;
          return "new-vm";
        case "start_utm_vm":
          return undefined;
        case "get_utm_vm_status":
          return { status: "started", ip_address: "192.168.1.100" };
        case "check_ha_ready":
        case "check_ha_updated":
          return true;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    await oneEvent(mount(), "install-complete");

    // The backend sizes the image before UTM imports it; no step follows
    expect(diskSizeGb).to.equal(128);
  });

  it("shows Automation settings advice from a structured Tauri rejection", async () => {
    const message =
      "Home Assistant Installer is not allowed to control UTM. Open System Settings > Privacy & Security > Automation, enable UTM under Home Assistant Installer, then try again.";
    mockTauriIpc((cmd) => {
      if (cmd === "download_utm_image") return "/tmp/haos.qcow2";
      if (cmd === "create_utm_vm")
        return Promise.reject(ipcError("utm", message, true));
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
        .shadowRoot!.querySelector(".error-message")!
        .textContent?.trim()
    ).to.equal(message);
    expect(wizardState.getState().selections.vmId).to.be.undefined;
  });

  it("does not recreate a VM when creation succeeded but starting failed", async () => {
    let creations = 0;
    mockTauriIpc((cmd) => {
      if (cmd === "download_utm_image") return "/tmp/fixture.qcow2";
      if (cmd === "discard_utm_image") return;
      if (cmd === "create_utm_vm") {
        creations++;
        return Promise.reject(
          ipcError(
            "utm_vm_created",
            "The VM was created. Open UTM to start it."
          )
        );
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = mount();
    const event = await oneEvent(el, "install-error");
    expect(event.detail.retryable).to.be.false;
    el.retry();
    await el.updateComplete;
    expect(creations).to.equal(1);
    expect(
      el
        .shadowRoot!.querySelector("install-progress")!
        .shadowRoot!.querySelector(".error-message")!.textContent
    ).to.contain("Open UTM to start it");
  });

  it("only lets the shell offer leaving once the VM was started", async () => {
    wizardState.setSelection("vmId", "existing-vm");
    const firstStatus = deferred<{ status: string; ip_address: null }>();
    let statusCalls = 0;
    const calls: string[] = [];
    mockTauriIpc((cmd) => {
      calls.push(cmd);
      if (cmd === "get_utm_vm_status")
        return ++statusCalls === 1
          ? firstStatus.promise
          : { status: "started", ip_address: null };
      if (cmd === "start_utm_vm") return undefined;
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const leavable: boolean[] = [];
    const el = mount();
    el.addEventListener("install-leavable", (event) =>
      leavable.push(
        (event as CustomEvent<{ leavable: boolean }>).detail.leavable
      )
    );
    await waitUntil(() => statusCalls === 1);
    await el.updateComplete;
    // The VM exists but isn't started: leaving now would leave it stopped
    expect(el.leavable).to.be.false;
    const layout = el.shadowRoot!.querySelector("install-progress")!;
    expect(layout.leavable).to.be.false;

    firstStatus.resolve({ status: "stopped", ip_address: null });
    await waitUntil(() => el.leavable, "never leavable after starting the VM");
    expect(calls).to.include("start_utm_vm");
    expect(leavable[leavable.length - 1]).to.be.true;
    // So the progress stops asking to keep the window open
    await el.updateComplete;
    expect(layout.leavable).to.be.true;
    el.remove();
  });

  it("shows the address it checks while waiting for Home Assistant", async () => {
    wizardState.setSelection("vmId", "existing-vm");
    const ready = deferred<boolean>();
    mockTauriIpc((cmd) => {
      if (cmd === "get_utm_vm_status")
        return { status: "started", ip_address: "192.0.2.50" };
      if (cmd === "check_ha_ready") return ready.promise;
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = mount();
    await el.updateComplete;
    const layout = el.shadowRoot!.querySelector("install-progress")!;
    // Only once the VM has an address and Home Assistant is checked there
    expect(layout.address).to.be.null;
    await waitUntil(() => layout.address === "http://192.0.2.50");
    expect(layout.stage).to.equal("ready");
    el.remove();
  });

  it("allows a timed-out readiness check to resume the existing VM", async () => {
    wizardState.setSelection("vmId", "existing-vm");
    const now = Date.now;
    let ready = false;
    mockTauriIpc((cmd) => {
      if (cmd === "get_utm_vm_status")
        return { status: "started", ip_address: "192.0.2.50" };
      if (cmd === "check_ha_ready") {
        // The first attempt only answers once its 5 minutes have passed
        if (!ready) Date.now = () => now() + 6 * 60 * 1000;
        return ready;
      }
      if (cmd === "check_ha_updated") return true;
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    try {
      const el = mount();
      const event = await oneEvent(el, "install-error");
      expect(event.detail.retryable).to.be.true;
      await el.updateComplete;
      expect(
        el
          .shadowRoot!.querySelector("install-progress")!
          .shadowRoot!.querySelector(".error-message")!.textContent
      ).to.contain("did not respond at 192.0.2.50 within 5 minutes");

      Date.now = now;
      ready = true;
      const completed = oneEvent(el, "install-complete");
      el.retry();
      await completed;
      expect(wizardState.getState().selections.vmId).to.equal("existing-vm");
    } finally {
      Date.now = now;
    }
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
          if (++starts === 1) throw ipcError("utm", "Start failed", true);
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
      if (cmd === "create_utm_vm") throw ipcError("utm", "import failed", true);
      if (cmd === "discard_utm_image") {
        released.push((args as { imagePath: string }).imagePath);
        throw ipcError("io", "cleanup failed");
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

  describe("stop", () => {
    const CANCELLED = {
      code: "cancelled",
      message: "Installation was cancelled.",
      retryable: true,
      details: {},
    };

    /**
     * Hold `download_utm_image` open, and record every stop, every VM
     * creation and every image the view hands back.
     */
    function mockStoppableDownload() {
      const download = deferred<string>();
      const started = deferred<void>();
      const stops: string[] = [];
      const creates: unknown[] = [];
      const released: string[] = [];
      let attempt = "";
      mockTauriIpc((cmd, args) => {
        switch (cmd) {
          case "download_utm_image":
            attempt = (args as { attempt: string }).attempt;
            started.resolve();
            return download.promise;
          case "cancel_vm_install":
            stops.push((args as { attempt: string }).attempt);
            return undefined;
          case "create_utm_vm":
            creates.push(args);
            return "new-vm";
          case "discard_utm_image":
            released.push((args as { imagePath: string }).imagePath);
            return undefined;
        }
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });
      return {
        download,
        started: started.promise,
        stops,
        creates,
        released,
        attempt: () => attempt,
      };
    }

    it("stops the download, and says no VM was created", async () => {
      const install = mockStoppableDownload();
      const el = mount();
      await install.started;
      await el.updateComplete;
      expect(el.stoppable).to.be.true;

      el.stop();
      await settle();
      expect(install.stops).to.deep.equal([install.attempt()]);
      expect(
        el.shadowRoot!.querySelector("install-progress")!.stageTitle
      ).to.equal("Stopping...");

      const failed = oneEvent(el, "install-error");
      install.download.reject(CANCELLED);
      expect((await failed).detail.retryable).to.be.true;
      await el.updateComplete;
      expect(errorText(el)).to.equal(
        "Installation stopped. No virtual machine was created in UTM."
      );
      expect(install.creates).to.deep.equal([]);
    });

    it("creates nothing when the download finished as the stop landed", async () => {
      const install = mockStoppableDownload();
      const el = mount();
      await install.started;

      el.stop();
      const failed = oneEvent(el, "install-error");
      install.download.resolve("/tmp/stopped.qcow2");
      await failed;
      await settle();

      expect(install.creates).to.deep.equal([]);
      expect(install.released).to.deep.equal(["/tmp/stopped.qcow2"]);
      expect(errorText(el)).to.equal(
        "Installation stopped. No virtual machine was created in UTM."
      );
    });

    it("cannot stop a resumed install that skips the download", async () => {
      wizardState.setSelection("vmId", "existing-vm");
      const el = mount();
      await el.updateComplete;

      expect(el.stoppable).to.be.false;
    });
  });
});
