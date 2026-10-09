import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import type { ProxmoxBridge } from "../../../../src/api/types.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import type { ProxmoxConfigureView } from "../../../../src/views/proxmox/proxmox-configure-view.js";
import "../../../../src/views/proxmox/proxmox-configure-view.js";
import {
  deferred,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

const bridge = (name: string): ProxmoxBridge => ({
  name,
  network_type: "bridge",
  vlan_aware: true,
  comments: null,
});

function mockNetworks(lookup: (node: string) => unknown) {
  mockTauriIpc((cmd, args) => {
    if (cmd === "proxmox_list_nodes")
      return [
        { name: "pve", status: "online" },
        { name: "pve2", status: "online" },
      ];
    if (cmd === "proxmox_get_next_vm_id") return 100;
    if (cmd === "proxmox_list_storage")
      return [
        { name: "local", active: true, content: ["images"], available: 100 },
      ];
    if (cmd === "proxmox_list_bridges")
      return lookup((args as { node: string }).node);
    throw new Error(`Unexpected command: ${cmd}`);
  });
}

async function mount() {
  return fixture<ProxmoxConfigureView>(
    html`<proxmox-configure-view></proxmox-configure-view>`
  );
}

async function ready() {
  await waitUntil(
    () => wizardState.getState().selections.proxmoxBridgeReady === true
  );
}

describe("Proxmox bridge selection", () => {
  beforeEach(() => {
    wizardState.startFlow("proxmox");
    wizardState.setSelection("proxmoxSession", {
      server_url: "https://pve.example:8006",
      ticket: "test",
      csrf_token: "test",
    });
  });
  afterEach(() => {
    restoreTauriIpc();
    wizardState.reset();
  });

  it("defaults to vmbr0 when present and persists another bridge across visits", async () => {
    mockNetworks(() => [
      bridge("vmbr1"),
      bridge("vmbr0"),
      { ...bridge("lan"), network_type: "vnet", comments: "Home network" },
    ]);
    const el = await mount();
    await ready();
    await el.updateComplete;
    const select =
      el.shadowRoot!.querySelector<HTMLSelectElement>("#network-bridge")!;
    expect(select.value).to.equal("vmbr0");
    select.value = "lan";
    select.dispatchEvent(new Event("change"));
    expect(wizardState.getState().selections.proxmoxBridge).to.equal("lan");
    el.remove();
    const restored = await mount();
    await ready();
    await restored.updateComplete;
    expect(
      restored.shadowRoot!.querySelector<HTMLSelectElement>("#network-bridge")!
        .value
    ).to.equal("lan");
    expect(restored.shadowRoot!.textContent).to.contain("SDN VNet");
  });

  it("selects the first available bridge when vmbr0 or a restored choice is absent", async () => {
    wizardState.setSelection("proxmoxBridge", "removed");
    mockNetworks(() => [bridge("vmbr2"), bridge("vmbr3")]);
    await mount();
    await ready();
    expect(wizardState.getState().selections.proxmoxBridge).to.equal("vmbr2");
  });

  it("keeps untagged defaults and restores a valid VLAN selection", async () => {
    mockNetworks(() => [bridge("vmbr0")]);
    const el = await mount();
    await ready();
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector("wa-details")!.hasAttribute("open")).to
      .be.false;
    expect(wizardState.getState().selections.proxmoxVlanTag).to.be.undefined;
    const input = el.shadowRoot!.querySelector<WaInput>("#vlan-tag")!;
    input.value = "42";
    input.dispatchEvent(new Event("input"));
    expect(wizardState.getState().selections.proxmoxVlanTag).to.equal(42);
    el.remove();
    const restored = await mount();
    await ready();
    await restored.updateComplete;
    expect(
      restored.shadowRoot!.querySelector<WaInput>("#vlan-tag")!.value
    ).to.equal("42");
    expect(
      restored.shadowRoot!.querySelector("wa-details")!.hasAttribute("open")
    ).to.be.true;
  });

  it("validates whole-number VLAN range and permits clearing the tag", async () => {
    mockNetworks(() => [bridge("vmbr0")]);
    const el = await mount();
    await ready();
    await el.updateComplete;
    const input = el.shadowRoot!.querySelector<WaInput>("#vlan-tag")!;
    for (const value of ["0", "4095", "1.5", "-1", "abc", "1e2", " "]) {
      input.value = value;
      input.dispatchEvent(new Event("input"));
      await el.updateComplete;
      expect(wizardState.getState().selections.proxmoxConfigureReady, value).to
        .be.false;
      await input.updateComplete;
      expect(input.validity.customError).to.be.true;
    }
    for (const value of ["1", "4094", ""]) {
      input.value = value;
      input.dispatchEvent(new Event("input"));
      await el.updateComplete;
      await input.updateComplete;
      expect(input.validity.customError).to.be.false;
      expect(wizardState.getState().selections.proxmoxConfigureReady, value).to
        .be.true;
      expect(wizardState.getState().selections.proxmoxVlanTag).to.equal(
        value ? Number(value) : undefined
      );
    }
  });

  it("blocks a tagged selection after changing to a non-VLAN-aware bridge", async () => {
    wizardState.setSelection("proxmoxVlanTag", 42);
    mockNetworks(() => [
      bridge("vmbr0"),
      { ...bridge("vmbr1"), vlan_aware: false },
    ]);
    const el = await mount();
    await ready();
    await el.updateComplete;
    const select =
      el.shadowRoot!.querySelector<HTMLSelectElement>("#network-bridge")!;
    select.value = "vmbr1";
    select.dispatchEvent(new Event("change"));
    await el.updateComplete;
    expect(wizardState.getState().selections.proxmoxConfigureReady).to.be.false;
    expect(el.shadowRoot!.textContent).to.contain("Select a VLAN-aware bridge");
    select.value = "vmbr0";
    select.dispatchEvent(new Event("change"));
    expect(wizardState.getState().selections.proxmoxConfigureReady).to.be.true;
    expect(wizardState.getState().selections.proxmoxVlanTag).to.equal(42);
  });

  for (const command of [
    "proxmox_list_nodes",
    "proxmox_list_bridges",
    "proxmox_list_storage",
  ]) {
    it(`preserves a VLAN through ${command} expiry and reconnect`, async () => {
      wizardState.setSelection("proxmoxVlanTag", 42);
      mockTauriIpc((cmd) => {
        if (cmd === command)
          throw { code: "proxmox_session_expired", message: "Session expired" };
        if (cmd === "proxmox_list_nodes")
          return [{ name: "pve", status: "online" }];
        if (cmd === "proxmox_get_next_vm_id") return 100;
        if (cmd === "proxmox_list_storage")
          return [
            {
              name: "local",
              active: true,
              content: ["images"],
              available: 100,
            },
          ];
        if (cmd === "proxmox_list_bridges") return [bridge("vmbr0")];
        throw new Error(`Unexpected command: ${cmd}`);
      });
      const el = await mount();
      await waitUntil(() => !!el.shadowRoot!.querySelector("[role=alert]"));
      await settle();
      expect(wizardState.getState().selections.proxmoxVlanTag).to.equal(42);
      expect(wizardState.getState().selections.proxmoxConfigureReady).to.be
        .false;
      expect(el.shadowRoot!.textContent).not.to.contain(
        "Select a VLAN-aware bridge"
      );
      el.shadowRoot!.querySelector<HTMLElement>("wa-button")!.click();
      el.remove();
      wizardState.setSelection("proxmoxSession", {
        server_url: "https://pve.example:8006",
        ticket: "new",
        csrf_token: "new",
      });
      mockNetworks(() => [bridge("vmbr0")]);
      const restored = await mount();
      await ready();
      await restored.updateComplete;
      expect(
        restored.shadowRoot!.querySelector<WaInput>("#vlan-tag")!.value
      ).to.equal("42");
      expect(
        restored.shadowRoot!.querySelector("wa-details")!.hasAttribute("open")
      ).to.be.true;
      expect(wizardState.getState().selections.proxmoxVlanTag).to.equal(42);
    });
  }

  it("clears the old bridge immediately on a node change and ignores stale replies", async () => {
    const stale = deferred<ProxmoxBridge[]>();
    let requests = 0;
    mockNetworks((node) =>
      node === "pve"
        ? [bridge("vmbr0")]
        : ++requests === 1
          ? stale.promise
          : [bridge("vmbr2")]
    );
    const el = await mount();
    await ready();
    await el.updateComplete;
    const select =
      el.shadowRoot!.querySelector<HTMLSelectElement>("wa-select")!;
    const changeNode = (name: string) => {
      select.value = name;
      select.dispatchEvent(new Event("change"));
    };
    changeNode("pve2");
    expect(wizardState.getState().selections.proxmoxBridge).to.equal("");
    expect(wizardState.getState().selections.proxmoxBridgeReady).to.be.false;
    changeNode("pve");
    changeNode("pve2");
    await ready();
    stale.resolve([bridge("stale")]);
    await settle();
    expect(wizardState.getState().selections.proxmoxBridge).to.equal("vmbr2");
  });

  it("blocks an empty result, clears a stale choice and retries", async () => {
    wizardState.setSelection("proxmoxBridge", "removed");
    let bridges: ProxmoxBridge[] = [];
    mockNetworks(() => bridges);
    const el = await mount();
    await waitUntil(() => !!el.shadowRoot!.querySelector("[role=alert]"));
    expect(wizardState.getState().selections.proxmoxBridge).to.equal("");
    expect(wizardState.getState().selections.proxmoxBridgeReady).to.be.false;
    expect(
      el.shadowRoot!.querySelector<HTMLSelectElement>("#network-bridge")!
        .disabled
    ).to.be.true;
    bridges = [bridge("vmbr1")];
    el.shadowRoot!.querySelector<HTMLElement>("wa-button")!.click();
    await ready();
    expect(wizardState.getState().selections.proxmoxBridge).to.equal("vmbr1");
  });

  it("does not trust a restored bridge while its lookup is pending", async () => {
    wizardState.setSelection("proxmoxBridge", "vmbr1");
    wizardState.setSelection("proxmoxBridgeReady", true);
    const pending = deferred<ProxmoxBridge[]>();
    mockNetworks(() => pending.promise);
    await mount();
    expect(wizardState.getState().selections.proxmoxBridgeReady).to.be.false;
    pending.resolve([bridge("vmbr1")]);
    await ready();
  });

  for (const initiallyOffline of [false, true]) {
    it(`retries node discovery after ${initiallyOffline ? "only offline nodes" : "no nodes"} are returned`, async () => {
      let online = false;
      let nodeRequests = 0;
      let networkRequests = 0;
      mockTauriIpc((cmd, args) => {
        if (cmd === "proxmox_list_nodes") {
          nodeRequests++;
          return online || initiallyOffline
            ? [{ name: "pve", status: online ? "online" : "offline" }]
            : [];
        }
        if (cmd === "proxmox_get_next_vm_id") return 100;
        expect((args as { node: string }).node).to.equal("pve");
        if (cmd === "proxmox_list_storage")
          return [
            {
              name: "local",
              active: true,
              content: ["images"],
              available: 100,
            },
          ];
        if (cmd === "proxmox_list_bridges") {
          networkRequests++;
          return [bridge("vmbr0")];
        }
        throw new Error(`Unexpected command: ${cmd}`);
      });
      const el = await mount();
      await waitUntil(() => !!el.shadowRoot!.querySelector("[role=alert]"));
      expect(
        el.shadowRoot!.querySelector("[role=alert]")!.textContent
      ).to.contain("No online Proxmox nodes found.");
      expect(wizardState.getState().selections.proxmoxBridgeReady).to.be.false;
      expect(networkRequests).to.equal(0);
      online = true;
      el.shadowRoot!.querySelector<HTMLElement>("wa-button")!.click();
      await ready();
      expect(nodeRequests).to.equal(2);
      expect(networkRequests).to.equal(1);
      expect(wizardState.getState().selections.proxmoxNode).to.equal("pve");
      expect(wizardState.getState().selections.proxmoxBridge).to.equal("vmbr0");
    });
  }

  it("clears bridge readiness and shows a lookup failure without adding reconnect behavior", async () => {
    wizardState.setSelection("proxmoxBridge", "vmbr1");
    mockNetworks(() => Promise.reject("Network lookup failed"));
    const el = await mount();
    await waitUntil(() => !!el.shadowRoot!.querySelector(".error-text"));
    expect(el.shadowRoot!.textContent).to.contain("Network lookup failed");
    expect(wizardState.getState().selections.proxmoxBridge).to.equal("");
    expect(wizardState.getState().selections.proxmoxBridgeReady).to.be.false;
    expect(wizardState.getState().selections.proxmoxSession).not.to.be
      .undefined;
  });

  it("preserves a successful non-default storage choice after a bridge failure and re-entry", async () => {
    wizardState.setSelection("proxmoxNode", "pve");
    wizardState.setSelection("proxmoxStorage", "local-lvm");
    let failBridge = true;
    mockTauriIpc((cmd) => {
      if (cmd === "proxmox_list_nodes")
        return [{ name: "pve", status: "online" }];
      if (cmd === "proxmox_get_next_vm_id") return 100;
      if (cmd === "proxmox_list_storage")
        return ["local", "local-lvm"].map((name) => ({
          name,
          active: true,
          content: ["images"],
          available: 100,
        }));
      if (cmd === "proxmox_list_bridges")
        return failBridge
          ? Promise.reject("Network lookup failed")
          : [bridge("vmbr0")];
      throw new Error(`Unexpected command: ${cmd}`);
    });
    const el = await mount();
    await waitUntil(
      () => !!el.shadowRoot!.textContent?.includes("Network lookup failed")
    );
    expect(wizardState.getState().selections.proxmoxStorage).to.equal(
      "local-lvm"
    );
    expect(wizardState.getState().selections.proxmoxBridgeReady).to.be.false;
    el.remove();
    failBridge = false;
    const restored = await mount();
    await ready();
    expect(wizardState.getState().selections.proxmoxStorage).to.equal(
      "local-lvm"
    );
    await restored.updateComplete;
    expect(
      restored.shadowRoot!.querySelectorAll<HTMLSelectElement>("wa-select")[1]
        .value
    ).to.equal("local-lvm");
  });

  for (const savedNodeMissing of [false, true]) {
    it(`chooses the replacement node's default bridge when the saved node is ${savedNodeMissing ? "missing" : "offline"}`, async () => {
      wizardState.setSelection("proxmoxNode", "pve");
      wizardState.setSelection("proxmoxBridge", "vmbr1");
      mockTauriIpc((cmd) => {
        if (cmd === "proxmox_list_nodes")
          return [
            ...(savedNodeMissing ? [] : [{ name: "pve", status: "offline" }]),
            { name: "pve2", status: "online" },
          ];
        if (cmd === "proxmox_get_next_vm_id") return 100;
        if (cmd === "proxmox_list_storage")
          return [
            {
              name: "local",
              active: true,
              content: ["images"],
              available: 100,
            },
          ];
        if (cmd === "proxmox_list_bridges")
          return [bridge("vmbr1"), bridge("vmbr0")];
        throw new Error(`Unexpected command: ${cmd}`);
      });
      await mount();
      await ready();
      expect(wizardState.getState().selections.proxmoxNode).to.equal("pve2");
      expect(wizardState.getState().selections.proxmoxBridge).to.equal("vmbr0");
    });
  }

  it("clears the bridge lookup error and restores readiness after retry", async () => {
    let failBridge = true;
    mockNetworks(() =>
      failBridge ? Promise.reject("Network lookup failed") : [bridge("vmbr0")]
    );
    const el = await mount();
    await waitUntil(
      () => !!el.shadowRoot!.textContent?.includes("Network lookup failed")
    );
    failBridge = false;
    await (el as unknown as { _loadStorage(): Promise<void> })._loadStorage();
    await ready();
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).not.to.contain("Network lookup failed");
    expect(wizardState.getState().selections.proxmoxBridge).to.equal("vmbr0");
  });

  for (const detached of [false, true]) {
    it(`ignores a bridge response after ${detached ? "detaching" : "replacing the session"}`, async () => {
      const pending = deferred<ProxmoxBridge[]>();
      let requested = false;
      mockNetworks(() => {
        requested = true;
        return pending.promise;
      });
      const el = await mount();
      await waitUntil(() => requested);
      if (detached) el.remove();
      else
        wizardState.setSelection("proxmoxSession", {
          server_url: "https://other.example:8006",
          ticket: "new",
          csrf_token: "new",
        });
      wizardState.setSelection("proxmoxBridge", "new-bridge");
      pending.resolve([bridge("old-bridge")]);
      await settle();
      expect(wizardState.getState().selections.proxmoxBridge).to.equal(
        "new-bridge"
      );
      expect(wizardState.getState().selections.proxmoxBridgeReady).to.be.false;
    });
  }
});
