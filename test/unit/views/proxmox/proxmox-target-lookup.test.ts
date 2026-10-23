import { expect } from "@open-wc/testing";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type {
  ProxmoxBridge,
  ProxmoxNode,
  ProxmoxStorage,
} from "../../../../src/api/types.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import { ProxmoxTargetLookup } from "../../../../src/views/proxmox/proxmox-target-lookup.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

const session = {
  server_url: "https://pve.example:8006",
  ticket: "ticket",
  csrf_token: "csrf",
};

const storage = (
  name: string,
  overrides: Partial<ProxmoxStorage> = {}
): ProxmoxStorage => ({
  name,
  storage_type: "lvmthin",
  active: true,
  content: ["images"],
  available: 100,
  ...overrides,
});

const bridge = (name: string): ProxmoxBridge => ({
  name,
  network_type: "bridge",
  vlan_aware: false,
  comments: null,
});

/** A lookup with a stand-in for the view, which only counts what it hears */
function createLookup() {
  const heard = { updates: 0, saves: 0, nextVmIds: [] as number[] };
  const controllers: ReactiveController[] = [];
  const host: ReactiveControllerHost = {
    addController: (controller) => controllers.push(controller),
    removeController: () => {},
    requestUpdate: () => heard.updates++,
    updateComplete: Promise.resolve(true),
  };
  const lookup = new ProxmoxTargetLookup(host, {
    session: () => wizardState.getState().selections.proxmoxSession,
    nodesLoaded: (nextVmId) => heard.nextVmIds.push(nextVmId),
    save: () => heard.saves++,
  });
  expect(controllers).to.include(lookup);
  // Like Lit, the view tells each of its controllers when it comes and goes
  controllers.forEach((controller) => controller.hostConnected?.());
  const leave = () =>
    controllers.forEach((controller) => controller.hostDisconnected?.());
  return { lookup, heard, leave };
}

describe("ProxmoxTargetLookup", () => {
  let nodes: ProxmoxNode[] | Promise<ProxmoxNode[]>;
  let storageFor: (node: string) => unknown;
  let bridges: ProxmoxBridge[];

  beforeEach(() => {
    wizardState.startFlow("proxmox");
    wizardState.setSelection("proxmoxSession", session);
    nodes = [
      { name: "pve", status: "offline", cpu_usage: null, cpu_count: null },
      { name: "pve2", status: "online", cpu_usage: null, cpu_count: 8 },
    ];
    storageFor = () => [
      storage("local", {
        storage_type: "dir",
        content: ["backup"],
      }),
      storage("local-lvm"),
    ];
    bridges = [bridge("vmbr1"), bridge("vmbr0")];
    mockTauriIpc((cmd, args) => {
      switch (cmd) {
        case "proxmox_list_nodes":
          return nodes;
        case "proxmox_get_next_vm_id":
          return 123;
        case "proxmox_list_storage":
          return storageFor((args as { node: string }).node);
        case "proxmox_list_bridges":
          return bridges;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  it("looks up the online nodes, then the first one's storage and bridges", async () => {
    const { lookup, heard } = createLookup();
    await lookup.loadNodes();

    expect(lookup.nodes.map((node) => node.name)).to.deep.equal(["pve2"]);
    expect(lookup.selectedNode).to.equal("pve2");
    expect(heard.nextVmIds).to.deep.equal([123]);
    // Only storage that can hold the VM disk
    expect(lookup.storages.map((s) => s.name)).to.deep.equal(["local-lvm"]);
    expect(lookup.selectedStorage).to.equal("local-lvm");
    expect(lookup.selectedBridge).to.equal("vmbr0");
    expect(lookup.loaded).to.be.true;
    // The directory storage can get Import, which no storage has yet
    expect(lookup.importStorage.ready).to.be.false;
    expect(lookup.importStorage.selected).to.equal("local");
    expect(heard.saves).to.be.greaterThan(0);
    expect(heard.updates).to.be.greaterThan(0);
  });

  it("keeps restored choices the server still offers", async () => {
    bridges = [bridge("vmbr0"), bridge("vmbr1")];
    storageFor = () => [storage("local-lvm"), storage("tank")];
    const { lookup } = createLookup();
    lookup.restore({
      ...wizardState.getState().selections,
      proxmoxNode: "pve2",
      proxmoxStorage: "tank",
      proxmoxBridge: "vmbr1",
    });
    await lookup.loadNodes();

    expect(lookup.selectedNode).to.equal("pve2");
    expect(lookup.selectedStorage).to.equal("tank");
    expect(lookup.selectedBridge).to.equal("vmbr1");
  });

  it("takes only the latest storage lookup's result", async () => {
    const { lookup } = createLookup();
    await lookup.loadNodes();
    const older = deferred<ProxmoxStorage[]>();
    storageFor = (node) =>
      node === "pve" ? older.promise : [storage(`${node}-storage`)];
    lookup.selectNode("pve");
    const first = lookup.loadStorage();
    lookup.selectNode("pve2");
    await lookup.loadStorage();

    older.resolve([storage("pve-storage")]);
    await first;
    expect(lookup.storages.map((s) => s.name)).to.deep.equal(["pve2-storage"]);
    expect(lookup.selectedStorage).to.equal("pve2-storage");
    expect(lookup.loadingStorage).to.be.false;
  });

  it("still takes session expiry from a superseded storage lookup", async () => {
    const { lookup } = createLookup();
    await lookup.loadNodes();
    const older = deferred<ProxmoxStorage[]>();
    let calls = 0;
    storageFor = () => (++calls === 1 ? older.promise : [storage("local-lvm")]);
    const first = lookup.loadStorage();
    await lookup.loadStorage();
    expect(lookup.error).to.be.null;

    older.reject(ipcError("proxmox_session_expired", "Session expired"));
    await first;
    expect(lookup.sessionExpired).to.be.true;
    expect(lookup.error).to.exist;
    expect(wizardState.getState().selections.proxmoxSession).to.be.undefined;
  });

  it("changes nothing once the session was replaced", async () => {
    const pending = deferred<ProxmoxNode[]>();
    nodes = pending.promise;
    const { lookup, heard } = createLookup();
    const loading = lookup.loadNodes();
    wizardState.setSelection("proxmoxSession", { ...session, ticket: "new" });

    pending.resolve([
      { name: "pve", status: "online", cpu_usage: null, cpu_count: null },
    ]);
    await loading;
    expect(lookup.nodes).to.deep.equal([]);
    expect(lookup.selectedNode).to.equal("");
    expect(heard.nextVmIds).to.deep.equal([]);
    expect(heard.saves).to.equal(0);
  });

  it("changes nothing once its view was left", async () => {
    const pending = deferred<ProxmoxNode[]>();
    nodes = pending.promise;
    const { lookup, heard, leave } = createLookup();
    const loading = lookup.loadNodes();
    leave();

    pending.reject(ipcError("proxmox_session_expired", "Session expired"));
    await loading;
    await settle();
    expect(lookup.error).to.be.null;
    expect(heard.saves).to.equal(0);
    expect(wizardState.getState().selections.proxmoxSession).to.equal(session);
  });

  it("reports an expired session without looking anything up", async () => {
    wizardState.setSelection("proxmoxSession", undefined);
    const { lookup } = createLookup();
    await lookup.loadNodes();

    expect(lookup.sessionExpired).to.be.true;
    expect(lookup.error!.message).to.contain("Your Proxmox session expired");
    expect(lookup.loadingNodes).to.be.false;
  });

  it("remembers where the latest lookup was started from once it is done", async () => {
    const { lookup } = createLookup();
    await lookup.loadNodes();
    expect(lookup.askedFrom).to.be.undefined;

    await lookup.loadStorage("storage");
    expect(lookup.reloadFrom).to.be.undefined;
    expect(lookup.askedFrom).to.equal("storage");

    // Another node is looked up because of the choice, not asked for
    lookup.selectNode("pve");
    await lookup.loadStorage();
    expect(lookup.askedFrom).to.be.undefined;

    await lookup.loadNodes("bridges");
    expect(lookup.askedFrom).to.equal("bridges");
  });

  for (const [name, accepted, ready] of [
    [
      "a directory",
      storage("local", { storage_type: "dir", content: ["import"] }),
      true,
    ],
    [
      "a network",
      storage("nfs", { storage_type: "nfs", content: ["import"] }),
      true,
    ],
    ["a full", storage("full", { content: ["import"], available: 0 }), false],
    [
      "an ESXi",
      storage("esxi", { storage_type: "esxi", content: ["import"] }),
      false,
    ],
    [
      "an inactive",
      storage("off", { content: ["import"], active: false }),
      false,
    ],
  ] as const) {
    it(`${ready ? "takes" : "doesn't take"} ${name} storage that accepts Import`, async () => {
      storageFor = () => [accepted, storage("local-lvm")];
      const { lookup } = createLookup();
      await lookup.loadNodes();

      expect(lookup.importStorage.ready).to.equal(ready);
    });
  }
});
