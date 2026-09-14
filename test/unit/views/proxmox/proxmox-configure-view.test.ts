import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/proxmox/proxmox-configure-view.js";
import type { ProxmoxConfigureView } from "../../../../src/views/proxmox/proxmox-configure-view.js";

/** Mount the view and wait for the node and storage lookups to settle */
async function mount(): Promise<ProxmoxConfigureView> {
  const el = await fixture<ProxmoxConfigureView>(html`
    <proxmox-configure-view></proxmox-configure-view>
  `);
  // Both dropdowns only render once their lookups have finished, which is
  // also when the view saves what it settled on
  await waitUntil(
    () => el.shadowRoot!.querySelectorAll(".select-dropdown").length === 2,
    "the node and storage dropdowns never loaded",
    { timeout: 4000 }
  );
  await el.updateComplete;
  return el;
}

describe("proxmox-configure-view", () => {
  beforeEach(() => {
    wizardState.startFlow("proxmox");
    // The view needs a session to look up nodes and storage
    wizardState.setSelection("proxmoxSession", {
      server_url: "https://192.168.1.100:8006",
      ticket: "mock-ticket",
      csrf_token: "mock-csrf",
    });
  });

  afterEach(() => {
    wizardState.reset();
  });

  it("saves the defaults on a first visit", async () => {
    await mount();

    const selections = wizardState.getState().selections;
    // The mocked server offers nodes pve/pve2 and storage local/local-lvm
    expect(selections.proxmoxNode).to.equal("pve");
    expect(selections.proxmoxStorage).to.equal("local");
    expect(selections.proxmoxVmId).to.equal(100);
    expect(selections.vmName).to.equal("home-assistant");
    expect(selections.cpuCores).to.equal(4);
    expect(selections.memoryMb).to.equal(4096);
    expect(selections.diskSizeGb).to.equal(32);
  });

  it("keeps the existing selections when the step is revisited", async () => {
    // What the user picked before stepping back to the connection step
    wizardState.setSelection("proxmoxNode", "pve2");
    wizardState.setSelection("proxmoxStorage", "local-lvm");
    wizardState.setSelection("proxmoxVmId", 250);
    wizardState.setSelection("vmName", "my-ha");
    wizardState.setSelection("cpuCores", 8);
    wizardState.setSelection("memoryMb", 8192);
    wizardState.setSelection("diskSizeGb", 64);

    const el = await mount();

    const selections = wizardState.getState().selections;
    expect(selections.proxmoxNode).to.equal("pve2");
    expect(selections.proxmoxStorage).to.equal("local-lvm");
    expect(selections.proxmoxVmId).to.equal(250);
    expect(selections.vmName).to.equal("my-ha");
    expect(selections.cpuCores).to.equal(8);
    expect(selections.memoryMb).to.equal(8192);
    expect(selections.diskSizeGb).to.equal(64);

    // And they are what the form shows, not just what is in the state
    const text = el.shadowRoot!.textContent!;
    expect(text).to.contain("8 cores");
    expect(text).to.contain("8 GB");
    expect(text).to.contain("64 GB");
  });

  it("falls back to an available node when the restored one is gone", async () => {
    wizardState.setSelection("proxmoxNode", "retired-node");

    await mount();

    expect(wizardState.getState().selections.proxmoxNode).to.equal("pve");
  });

  it("falls back to available storage when the restored one is gone", async () => {
    wizardState.setSelection("proxmoxStorage", "retired-storage");

    await mount();

    expect(wizardState.getState().selections.proxmoxStorage).to.equal("local");
  });
});
