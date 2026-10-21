import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/proxmox/proxmox-confirm-view.js";
import type { ProxmoxConfirmView } from "../../../../src/views/proxmox/proxmox-confirm-view.js";
import { mockTauriIpc, restoreTauriIpc } from "../../tauri-ipc.js";

async function renderConfirm() {
  mockTauriIpc((cmd) => {
    expect(cmd).to.equal("get_haos_release");
    return { version: "16.3", images: [] };
  });
  const el = await fixture<ProxmoxConfirmView>(
    html`<proxmox-confirm-view></proxmox-confirm-view>`
  );
  await waitUntil(() => el.shadowRoot!.textContent!.includes("16.3"));
  return el;
}

/** Each summary row's text, whitespace collapsed. */
function rows(el: ProxmoxConfirmView) {
  return [...el.shadowRoot!.querySelectorAll(".summary-row")].map((row) =>
    row.textContent!.replace(/\s+/g, " ").trim()
  );
}

describe("proxmox-confirm-view", () => {
  afterEach(() => {
    restoreTauriIpc();
    wizardState.reset();
  });

  it("summarises the server, VM, disk and release the install uses", async () => {
    wizardState.startFlow("proxmox");
    wizardState.setSelection("proxmoxNode", "pve-2");
    wizardState.setSelection("proxmoxStorage", "local-lvm");
    wizardState.setSelection("proxmoxBridge", "vmbr1");
    wizardState.setSelection("vmName", "ha-test");
    wizardState.setSelection("proxmoxVmId", 105);
    wizardState.setSelection("cpuCores", 6);
    wizardState.setSelection("memoryMb", 8192);
    wizardState.setSelection("diskSizeGb", 128);
    const el = await renderConfirm();

    const [server, vm, disk, release] = rows(el);
    expect(server).to.contain("Node: pve-2");
    expect(server).to.contain("Storage: local-lvm");
    expect(server).to.contain("Network bridge: vmbr1");
    expect(server).not.to.contain("VLAN");
    expect(vm).to.contain("ha-test (ID: 105)");
    expect(vm).to.contain("6 CPU cores, 8 GB RAM");
    expect(disk).to.contain("128 GB");
    expect(release).to.contain("Version 16.3");
  });

  it("shows the VLAN tag the VM's network gets", async () => {
    wizardState.startFlow("proxmox");
    wizardState.setSelection("proxmoxBridge", "vmbr0");
    wizardState.setSelection("proxmoxVlanTag", 20);
    const el = await renderConfirm();
    expect(rows(el)[0]).to.contain("Network bridge: vmbr0 VLAN tag: 20");
  });

  it("shows the defaults the install falls back to", async () => {
    wizardState.startFlow("proxmox");
    const el = await renderConfirm();
    const [server, vm, disk] = rows(el);
    expect(server).to.contain("Node: pve Storage: local Network bridge:");
    expect(vm).to.contain("home-assistant (ID: 100)");
    expect(vm).to.contain("4 CPU cores, 4 GB RAM");
    expect(disk).to.contain("32 GB");
  });

  it("follows changes to the selections while shown", async () => {
    wizardState.startFlow("proxmox");
    wizardState.setSelection("vmName", "before");
    const el = await renderConfirm();
    wizardState.setSelection("vmName", "after");
    await el.updateComplete;
    expect(rows(el)[1]).to.contain("after (ID: 100)");
  });
});
