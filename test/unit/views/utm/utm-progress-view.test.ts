import {
  aTimeout,
  expect,
  fixtureSync,
  html,
  oneEvent,
} from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/utm/utm-progress-view.js";
import type { UtmProgressView } from "../../../../src/views/utm/utm-progress-view.js";
import { mockTauriIpc, restoreTauriIpc } from "../../tauri-ipc.js";

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
    expect(el.shadowRoot!.textContent).to.contain("Downloading");
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
    wizardState.setSelection("utmImagePath", "/tmp/haos.qcow2");
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
    wizardState.setSelection("utmImagePath", "/tmp/haos.qcow2");
    wizardState.setSelection("vmId", "existing-vm");

    const el = mount();
    await oneEvent(el, "install-complete");

    const selections = wizardState.getState().selections;
    // A second createUtmVm call would have replaced this with a new id
    expect(selections.vmId).to.equal("existing-vm");
    expect(selections.ipAddress).to.equal("192.168.1.100");
    expect(el.hasError).to.be.false;
  });

  it("skips the download when a previous attempt already fetched the image", async () => {
    wizardState.setSelection("utmImagePath", "/tmp/haos.qcow2");

    const el = mount();
    await el.updateComplete;

    // Straight to creating the VM rather than downloading all over again
    expect(el.shadowRoot!.textContent).to.contain("Creating virtual machine");
  });

  it("retries a failed disk resize instead of starting an undersized VM", async () => {
    wizardState.setSelection("utmImagePath", "/tmp/haos.qcow2");

    const calls: string[] = [];
    let resizeAttempts = 0;
    mockTauriIpc((cmd) => {
      calls.push(cmd);
      switch (cmd) {
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

  it("asks the VM for its address again on a retry", async () => {
    // A previous attempt found the VM at an address it no longer has
    wizardState.setSelection("utmImagePath", "/tmp/haos.qcow2");
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
});
