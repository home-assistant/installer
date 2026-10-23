import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import type {
  ProxmoxBridge,
  ProxmoxStorage,
} from "../../../../src/api/types.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/proxmox/proxmox-configure-view.js";
import type { ProxmoxConfigureView } from "../../../../src/views/proxmox/proxmox-configure-view.js";
import type { ProxmoxTargetLookup } from "../../../../src/views/proxmox/proxmox-target-lookup.js";
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
const directory: ProxmoxStorage = {
  name: "local",
  storage_type: "dir",
  active: true,
  content: ["backup"],
  available: 1e11,
};
const withImport: ProxmoxStorage = {
  ...directory,
  content: ["backup", "import"],
};
const disk: ProxmoxStorage = {
  ...directory,
  name: "local-lvm",
  storage_type: "lvmthin",
  content: ["images"],
};
const vmbr0: ProxmoxBridge = {
  name: "vmbr0",
  network_type: "bridge",
  vlan_aware: false,
  comments: null,
};

const hint = (el: ProxmoxConfigureView) =>
  el.shadowRoot!.querySelector<HTMLElement>(".next-hint")!;
const focused = (el: ProxmoxConfigureView) => el.shadowRoot!.activeElement;
const lookupOf = (el: ProxmoxConfigureView) =>
  (el as unknown as { _lookup: ProxmoxTargetLookup })._lookup;
const focusAlerts = (el: ProxmoxConfigureView) =>
  el.shadowRoot!.querySelectorAll("[data-focus-alert], [role=alert]");

describe("proxmox-configure-view announcements", () => {
  let nodes: () => unknown;
  let storages: () => unknown;
  let bridges: () => unknown;
  let enable: () => unknown;
  let check: () => unknown;

  beforeEach(() => {
    wizardState.startFlow("proxmox");
    wizardState.setSelection("proxmoxSession", session);
    nodes = () => [{ name: "pve", status: "online" }];
    storages = () => [withImport, disk];
    bridges = () => [vmbr0];
    enable = () => true;
    check = () => null;
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "proxmox_list_nodes":
          return nodes();
        case "proxmox_get_next_vm_id":
          return 100;
        case "proxmox_list_storage":
          return storages();
        case "proxmox_list_bridges":
          return bridges();
        case "proxmox_enable_storage_import":
          return enable();
        case "proxmox_check_vm_config":
          return check();
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  async function mount() {
    const el = await fixture<ProxmoxConfigureView>(
      html`<proxmox-configure-view></proxmox-configure-view>`
    );
    await waitUntil(
      () => !lookupOf(el).loadingNodes,
      "the lookups never finished"
    );
    await settle();
    await el.updateComplete;
    return el;
  }

  /** Enable Import as the consent dialog would, without opening it */
  async function approveImport(el: ProxmoxConfigureView) {
    // A test page in the background never finishes the dialog's animations
    lookupOf(el).importStorage.dialog = true;
    el.shadowRoot!.querySelector("info-dialog")!.dispatchEvent(
      new CustomEvent("dialog-primary")
    );
    await settle();
    await el.updateComplete;
  }

  for (const [missing, setUp, said] of [
    [
      "storage that accepts Import",
      () => (storages = () => [directory, disk]),
      "Next is unavailable until a storage on pve accepts Import.",
    ],
    [
      "storage for the VM disk",
      () => (storages = () => [withImport]),
      "Next is unavailable until pve has storage that can hold the VM disk.",
    ],
    [
      "a network bridge",
      () => (bridges = () => []),
      "Next is unavailable until pve has a network bridge.",
    ],
    [
      "an online node",
      () => (nodes = () => [{ name: "pve", status: "offline" }]),
      "Next is unavailable until a Proxmox node is online.",
    ],
  ] as const) {
    it(`says near Next that it needs ${missing}, leaving the focus in the form`, async () => {
      setUp();
      const answer = nodes;
      const pending = deferred<unknown>();
      nodes = () => pending.promise;
      const el = await fixture<ProxmoxConfigureView>(
        html`<proxmox-configure-view></proxmox-configure-view>`
      );
      // Someone types the name while the lookups run
      const name = el.shadowRoot!.querySelector<WaInput>("wa-input")!;
      await name.updateComplete;
      name.focus();
      expect(focused(el)).to.equal(name);
      expect(hint(el).textContent!.trim()).to.equal("");

      pending.resolve(answer());
      await waitUntil(
        () => hint(el).textContent!.includes(said),
        "the hint never said what Next needs"
      );
      await settle();
      await el.updateComplete;

      // A polite status, which doesn't take the focus to be read out
      expect(hint(el).getAttribute("role")).to.equal("status");
      expect(focusAlerts(el)).to.have.length(0);
      expect(focused(el)).to.equal(name);
    });
  }

  it("sits last on the step, and takes no room once nothing blocks Next", async () => {
    storages = () => [directory, disk];
    const el = await mount();
    const details = el.shadowRoot!.querySelector("wa-details")!;
    expect(
      details.compareDocumentPosition(hint(el)) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).to.be.greaterThan(0);
    expect(hint(el).getBoundingClientRect().height).to.be.greaterThan(0);

    storages = () => [withImport, disk];
    await approveImport(el);
    await waitUntil(() => !el.shadowRoot!.querySelector(".import-setting"));
    await el.updateComplete;
    expect(hint(el).textContent!.trim()).to.equal("");
    expect(hint(el).getBoundingClientRect().height).to.equal(0);
  });

  for (const [retryClass, setUp, said] of [
    [
      ".storage-retry",
      () => (storages = () => [withImport]),
      "No active storage on this node can hold the VM disk.",
    ],
    [
      ".bridge-retry",
      () => (bridges = () => []),
      "No network bridges available on this node.",
    ],
  ] as const) {
    it(`takes the focus to say what ${retryClass} found once more`, async () => {
      setUp();
      const el = await mount();
      const message = el.shadowRoot!.querySelector<HTMLElement>(".error-text")!;
      expect(message.textContent).to.contain(said);
      // Nobody asked for the first lookup
      expect(message.hasAttribute("data-focus-alert")).to.be.false;

      const retry = el.shadowRoot!.querySelector<HTMLElement>(retryClass)!;
      retry.focus();
      retry.click();
      await waitUntil(
        () =>
          focused(el)?.classList.contains("error-text") &&
          focused(el)!.textContent!.includes(said),
        "what Try again found never took the focus"
      );
      expect(focused(el)!.hasAttribute("data-focus-alert")).to.be.true;
    });
  }

  it("keeps the focus on Refresh storage, and says again what Next needs", async () => {
    storages = () => [directory, disk];
    const el = await mount();
    const said = "Next is unavailable until a storage on pve accepts Import.";
    expect(hint(el).textContent).to.contain(said);

    const lookup = deferred<ProxmoxStorage[]>();
    storages = () => lookup.promise;
    const refresh =
      el.shadowRoot!.querySelector<HTMLElement>(".refresh-storage")!;
    refresh.focus();
    refresh.click();
    await el.updateComplete;
    // Empty meanwhile, so the same result is read out again
    expect(hint(el).textContent!.trim()).to.equal("");

    lookup.resolve([directory, disk]);
    await waitUntil(() => hint(el).textContent!.includes(said));
    await settle();
    await el.updateComplete;
    expect(focused(el)).to.equal(refresh);
    expect(focusAlerts(el)).to.have.length(0);
  });

  it("takes the focus when Enable Import fails", async () => {
    storages = () => [directory, disk];
    enable = () => {
      throw ipcError("proxmox_api", "denied");
    };
    const el = await mount();
    await approveImport(el);

    const error = el.shadowRoot!.querySelector(
      ".import-setting [data-focus-alert]"
    );
    expect(error).to.exist;
    expect(focused(el)).to.equal(error);
  });

  it("takes the focus when the settings check fails", async () => {
    check = () => {
      throw ipcError("proxmox_api", "denied");
    };
    const el = await mount();
    expect(hint(el).textContent!.trim()).to.equal("");

    expect(await el.check()).to.be.false;
    await el.updateComplete;
    const error = el.shadowRoot!.querySelector("[data-focus-alert]");
    expect(error).to.exist;
    expect(focused(el)).to.equal(error);
  });
});
