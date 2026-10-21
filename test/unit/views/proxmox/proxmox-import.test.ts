import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import type WaSelect from "@home-assistant/webawesome/dist/components/select/select.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import type { ProxmoxStorage } from "../../../../src/api/types.js";
import {
  proxmoxEnableStorageImport,
  proxmoxListStorage,
} from "../../../../src/api/commands.js";
import "../../../../src/views/proxmox/proxmox-configure-view.js";
import "../../../../src/views/proxmox/proxmox-success-view.js";
import type { ProxmoxConfigureView } from "../../../../src/views/proxmox/proxmox-configure-view.js";
import type { InfoDialog } from "../../../../src/components/info-dialog.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

const session = {
  server_url: "https://pve.example:8006",
  id: 1,
  certificate_sha256: null,
};
const directory: ProxmoxStorage = {
  name: "local",
  storage_type: "dir",
  active: true,
  content: ["backup"],
  available: 1e11,
  total: 2e11,
};
const disk: ProxmoxStorage = {
  ...directory,
  name: "local-lvm",
  storage_type: "lvmthin",
  content: ["images"],
};

describe("Proxmox import consent", () => {
  let writes: unknown[];
  let reads: number;
  let storages: ProxmoxStorage[];
  let enable: () => unknown;
  let list: () => unknown;

  beforeEach(() => {
    wizardState.startFlow("proxmox");
    wizardState.setSelection("proxmoxSession", session);
    writes = [];
    reads = 0;
    storages = [directory, disk];
    enable = () => {
      storages = [{ ...directory, content: ["backup", "import"] }, disk];
      return true;
    };
    list = () => storages;
    mockTauriIpc((cmd, args) => {
      switch (cmd) {
        case "proxmox_list_nodes":
          return [
            { name: "pve", status: "online" },
            { name: "pve2", status: "online" },
          ];
        case "proxmox_get_next_vm_id":
          return 100;
        case "proxmox_list_bridges":
          return [{ name: "vmbr0", network_type: "bridge", comments: null }];
        case "proxmox_list_storage":
          reads++;
          return list();
        case "proxmox_enable_storage_import":
          writes.push(args);
          return enable();
        default:
          throw new Error(`Unexpected IPC: ${cmd}`);
      }
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
    // The node, storage and bridge dropdowns render once the lookups finish
    await waitUntil(
      () => el.shadowRoot!.querySelectorAll("wa-select").length >= 3
    );
    await settle();
    await el.updateComplete;
    return el;
  }

  function nodeSelect(el: ProxmoxConfigureView) {
    return el.shadowRoot!.querySelector("wa-select") as WaSelect;
  }

  function importSelect(el: ProxmoxConfigureView) {
    return el.shadowRoot!.querySelector(
      ".import-setting wa-select"
    ) as WaSelect | null;
  }

  async function click(el: ProxmoxConfigureView, label: string) {
    const button = [...el.shadowRoot!.querySelectorAll("wa-button")].find(
      (b) => b.textContent!.trim() === label
    ) as HTMLElement;
    expect(button, label).to.exist;
    button.click();
    await el.updateComplete;
  }

  async function approve(el: ProxmoxConfigureView) {
    await click(el, "Enable Import...");
    el.shadowRoot!.querySelector("info-dialog")!.dispatchEvent(
      new CustomEvent("dialog-primary")
    );
    await settle();
    await el.updateComplete;
  }

  it("does not mutate on load, storage selection, opening, or declining the dialog", async () => {
    storages.push({ ...directory, name: "other" });
    const el = await mount();
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
    const select = importSelect(el)!;
    select.value = "other";
    select.dispatchEvent(new Event("change"));
    await click(el, "Enable Import...");
    const dialog = el.shadowRoot!.querySelector("info-dialog") as InfoDialog;
    expect(dialog.open).to.be.true;
    expect(dialog.message).to.contain('"other"');
    expect(dialog.message).to.contain("cluster-wide");
    expect(dialog.message).to.contain("not automatically restore");
    dialog.dispatchEvent(new CustomEvent("dialog-secondary"));
    await el.updateComplete;
    expect(writes).to.deep.equal([]);
    expect(wizardState.getState().selections.proxmoxImportChanges).to.be
      .undefined;
    expect(el.shadowRoot!.textContent).to.contain("Installation is paused");
    expect(
      el.shadowRoot!.querySelector<HTMLAnchorElement>(".import-setting a")!.href
    ).to.contain("pve.proxmox.com");
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
  });

  it("names the only candidate without an extra dropdown", async () => {
    const el = await mount();
    expect(importSelect(el)).to.be.null;
    expect(el.shadowRoot!.textContent).to.contain(
      'Import can be enabled on "local"'
    );
    await click(el, "Enable Import...");
    const dialog = el.shadowRoot!.querySelector("info-dialog") as InfoDialog;
    expect(dialog.message).to.contain('"local"');
    expect(writes).to.deep.equal([]);
  });

  it("sends the approved target, preserves VM storage, and refreshes before proceeding", async () => {
    const el = await mount();
    const refresh = deferred<ProxmoxStorage[]>();
    list = () => refresh.promise;
    await approve(el);
    expect(writes).to.deep.equal([
      { sessionId: session.id, node: "pve", storage: "local" },
    ]);
    expect(reads).to.equal(2);
    expect(
      wizardState.getState().selections.proxmoxImportChanges
    ).to.deep.equal([{ serverOrigin: session.server_url, storage: "local" }]);
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
    refresh.resolve(storages);
    await settle();
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.true;
    expect(wizardState.getState().selections.proxmoxStorage).to.equal(
      "local-lvm"
    );
  });

  it("does not prompt when active import storage exists, including a non-directory backend", async () => {
    storages.push({ ...directory, storage_type: "nfs", content: ["import"] });
    const el = await mount();
    expect(el.shadowRoot!.querySelector("info-dialog")).to.be.null;
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.true;
    expect(writes).to.deep.equal([]);
    expect(wizardState.getState().selections.proxmoxImportChanges).to.be
      .undefined;
  });

  it("offers only active directory candidates and ignores full or source-only import storage", async () => {
    storages = [
      disk,
      { ...directory, active: false },
      { ...directory, name: "full", available: 0, content: ["import"] },
      { ...directory, name: "esxi", storage_type: "esxi", content: ["import"] },
    ];
    const el = await mount();
    expect(importSelect(el)).to.be.null;
    expect(
      [...el.shadowRoot!.querySelectorAll("wa-button")].map((b) =>
        b.textContent!.trim()
      )
    ).not.to.include("Enable Import...");
    expect(el.shadowRoot!.textContent).to.contain(
      "No active directory storage"
    );
    expect(el.shadowRoot!.textContent).to.contain("Free up space");
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
  });

  for (const [code, message, shown] of [
    [
      "proxmox_action_required",
      "Your Proxmox user is missing Datastore.Allocate on /storage.",
      "Datastore.Allocate",
    ],
    [
      "proxmox_action_required",
      "Proxmox did not enable Import on storage 'local'. Refresh storage and try again; its configuration or your permissions may have changed.",
      "Refresh storage and try again",
    ],
    // Remote details stay out of the view; the code picks a safe message
    ["proxmox_api", "raw server response", "account permissions"],
  ]) {
    it(`keeps choices and allows explicit retry after ${code}: ${shown}`, async () => {
      const succeed = enable;
      enable = () => {
        throw ipcError(code, message);
      };
      const el = await mount();
      await approve(el);
      expect(
        el.shadowRoot!.querySelector("[role=alert]")!.textContent
      ).to.contain(shown);
      expect(el.shadowRoot!.textContent).not.to.contain("raw server response");
      expect(el.shadowRoot!.querySelectorAll("wa-select").length).to.equal(3);
      expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
      expect(wizardState.getState().selections.proxmoxImportChanges).to.be
        .undefined;
      enable = succeed;
      await approve(el);
      expect(writes.length).to.equal(2);
      expect(wizardState.getState().selections.proxmoxImportReady).to.be.true;
    });
  }

  it("offers reconnect when enabling Import finds the session expired", async () => {
    enable = () => {
      throw ipcError(
        "proxmox_session_expired",
        "Proxmox session expired or invalid. Please reconnect to Proxmox."
      );
    };
    const el = await mount();
    await approve(el);
    expect(el.shadowRoot!.textContent).to.contain("Reconnect");
    expect(wizardState.getState().selections.proxmoxSession).to.be.undefined;
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
    expect(writes.length).to.equal(1);
  });

  it("keeps Next blocked when the post-change storage refresh fails and allows read-only retry", async () => {
    const el = await mount();
    list = () => {
      throw ipcError("proxmox_api", "storage refresh denied", true);
    };
    await approve(el);
    expect(el.shadowRoot!.querySelector("[role=alert]")).to.exist;
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
    // A failed read after the write does not forget the accepted change
    expect(
      wizardState.getState().selections.proxmoxImportChanges
    ).to.deep.equal([{ serverOrigin: session.server_url, storage: "local" }]);
    list = () => storages;
    await click(el, "Try again");
    await waitUntil(
      () => wizardState.getState().selections.proxmoxImportReady === true
    );
    expect(writes.length).to.equal(1);
  });

  for (const result of ["success", "failure"]) {
    for (const change of ["node", "session", "detach"]) {
      it(`ignores stale ${result} after a ${change} change`, async () => {
        const pending = deferred<boolean>();
        enable = () => pending.promise;
        const el = await mount();
        await approve(el);
        if (change === "node") {
          const select = nodeSelect(el);
          expect(select.disabled).to.be.true;
          select.value = "pve2";
          select.dispatchEvent(new Event("change"));
        } else if (change === "session") {
          wizardState.setSelection("proxmoxSession", {
            ...session,
            id: 2,
          });
        } else {
          el.remove();
          wizardState.startFlow("sbc");
        }
        await settle();
        const before = wizardState.getState();
        const beforeReads = reads;
        if (result === "success") pending.resolve(true);
        else pending.reject(ipcError("proxmox_api", "obsolete session failed"));
        await settle();
        if (result === "success" && change !== "detach") {
          // The cluster-wide change happened; only the view's state is stale
          expect(
            wizardState.getState().selections.proxmoxImportChanges
          ).to.deep.equal([
            { serverOrigin: session.server_url, storage: "local" },
          ]);
          expect(wizardState.getState().selections.proxmoxNode).to.equal(
            before.selections.proxmoxNode
          );
          expect(wizardState.getState().selections.proxmoxImportReady).to.equal(
            before.selections.proxmoxImportReady
          );
        } else {
          expect(wizardState.getState()).to.equal(before);
        }
        expect(reads).to.equal(beforeReads);
        expect(el.shadowRoot!.querySelector(".import-setting [role=alert]")).to
          .be.null;
      });
    }
  }

  it("ignores a previous session's delayed storage read", async () => {
    const old = deferred<ProxmoxStorage[]>();
    list = () => old.promise;
    await fixture<ProxmoxConfigureView>(
      html`<proxmox-configure-view></proxmox-configure-view>`
    );
    await waitUntil(() => reads === 1);
    wizardState.setSelection("proxmoxSession", {
      ...session,
      id: 2,
    });
    old.resolve([{ ...directory, content: ["import", "images"] }]);
    await settle();
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.false;
  });

  it("does not claim a change when another actor already enabled Import", async () => {
    enable = () => {
      storages = [{ ...directory, content: ["backup", "import"] }, disk];
      return false;
    };
    const el = await mount();
    await approve(el);
    expect(wizardState.getState().selections.proxmoxImportReady).to.be.true;
    expect(wizardState.getState().selections.proxmoxImportChanges).to.be
      .undefined;
  });

  it("retains the reminder after reconnecting to the same server", async () => {
    const el = await mount();
    await approve(el);
    el.remove();
    wizardState.setSelection("proxmoxSession", {
      ...session,
      server_url: "https://PVE.EXAMPLE:8006/",
      id: 2,
    });
    const success = await fixture(
      html`<proxmox-success-view></proxmox-success-view>`
    );
    const reminder = success.shadowRoot!.querySelector(".import-reminder");
    expect(reminder).to.exist;
    expect(reminder!.getAttribute("aria-label")).to.equal(
      "Import storage reminder"
    );
    expect(reminder!.textContent).to.contain('"local"');
  });

  it("records a late successful enable after same-server re-login", async () => {
    const pending = deferred<boolean>();
    enable = () => pending.promise;
    const el = await mount();
    await approve(el);
    el.remove();
    wizardState.setSelection("proxmoxSession", {
      ...session,
      server_url: "https://PVE.EXAMPLE:8006/",
      id: 2,
    });
    const success = await fixture(
      html`<proxmox-success-view></proxmox-success-view>`
    );
    expect(success.shadowRoot!.querySelector(".import-reminder")).to.be.null;
    pending.resolve(true);
    await settle();
    expect(
      wizardState.getState().selections.proxmoxImportChanges
    ).to.deep.equal([{ serverOrigin: session.server_url, storage: "local" }]);
    await (success as HTMLElement & { updateComplete: Promise<unknown> })
      .updateComplete;
    expect(
      success.shadowRoot!.querySelector(".import-reminder")!.textContent
    ).to.contain('"local"');
    expect(writes).to.have.length(1);
  });

  for (const transition of ["detach", "reset", "new flow"]) {
    it(`handles a successful delayed write after ${transition}`, async () => {
      const pending = deferred<boolean>();
      enable = () => pending.promise;
      const el = await mount();
      await approve(el);
      el.remove();
      if (transition === "reset") wizardState.reset();
      if (transition === "new flow") {
        wizardState.startFlow("proxmox");
        wizardState.setSelection("proxmoxSession", session);
      }
      pending.resolve(true);
      await settle();
      expect(
        wizardState.getState().selections.proxmoxImportChanges
      ).to.deep.equal(
        transition === "detach"
          ? [{ serverOrigin: session.server_url, storage: "local" }]
          : undefined
      );
    });
  }

  it("keeps distinct changed storage names and deduplicates repeat changes", async () => {
    const el = await mount();
    await approve(el);
    for (const name of ["other", "local"]) {
      storages = [{ ...directory, name }, disk];
      const select = nodeSelect(el);
      select.value = "pve2";
      select.dispatchEvent(new Event("change"));
      await settle();
      await el.updateComplete;
      await approve(el);
    }
    expect(
      wizardState.getState().selections.proxmoxImportChanges
    ).to.deep.equal([
      { serverOrigin: session.server_url, storage: "local" },
      { serverOrigin: session.server_url, storage: "other" },
    ]);
    expect(writes).to.have.length(3);
    wizardState.startFlow("proxmox");
    expect(wizardState.getState().selections.proxmoxImportChanges).to.be
      .undefined;
  });

  it("deduplicates a storage across renewed logins and equivalent URL origins", async () => {
    for (const [id, server_url] of [
      "https://PVE.EXAMPLE:443/",
      "https://pve.example",
    ].entries()) {
      wizardState.setSelection("proxmoxSession", {
        ...session,
        id: id + 1,
        server_url,
      });
      storages = [directory, disk];
      const el = await mount();
      await approve(el);
      el.remove();
    }
    expect(
      wizardState.getState().selections.proxmoxImportChanges
    ).to.deep.equal([
      { serverOrigin: "https://pve.example", storage: "local" },
    ]);
    expect(writes).to.have.length(2);
  });

  it("shows only the current server's historical changes and never sends rollback IPC", async () => {
    wizardState.setSelection("proxmoxImportChanges", [
      { serverOrigin: session.server_url, storage: "local" },
      { serverOrigin: session.server_url, storage: "other" },
      { serverOrigin: "https://another.example:8006", storage: "old-storage" },
    ]);
    const el = await fixture(
      html`<proxmox-success-view></proxmox-success-view>`
    );
    const reminder = el.shadowRoot!.querySelector(".import-reminder")!;
    expect(reminder.textContent).to.contain('"local"');
    expect(reminder.textContent).to.contain('"other"');
    expect(reminder.textContent).not.to.contain("old-storage");
    expect(reminder.textContent).to.contain("cluster-wide");
    expect(reminder.textContent).to.contain("no other");
    expect(reminder.textContent).to.contain("content types unchanged");
    expect(reminder.querySelector("a")!.href).to.contain("#storage_directory");
    wizardState.setSelection("proxmoxSession", {
      ...session,
      server_url: "https://different.example:8006",
      id: 2,
    });
    await (el as HTMLElement & { updateComplete: Promise<unknown> })
      .updateComplete;
    expect(el.shadowRoot!.querySelector(".import-reminder")).to.be.null;
    expect(writes).to.deep.equal([]);
  });

  it("browser mock adds Import persistently without removing other content types", async () => {
    restoreTauriIpc();
    const mockSession = {
      ...session,
      server_url: "https://mock-import.example:8006",
    };
    const before = await proxmoxListStorage(mockSession, "pve");
    expect(before[0].content).not.to.include("import");
    expect(await proxmoxEnableStorageImport(mockSession, "pve", "local")).to.be
      .true;
    const after = await proxmoxListStorage(mockSession, "pve2");
    expect(after[0].content).to.deep.equal([...before[0].content, "import"]);
    expect(await proxmoxEnableStorageImport(mockSession, "pve", "local")).to.be
      .false;
  });

  it("browser mock persists Import by equivalent origin without affecting another server", async () => {
    restoreTauriIpc();
    const first = {
      ...session,
      server_url: "https://MOCK-ORIGIN.example:443/",
    };
    const renewed = {
      ...session,
      server_url: "https://mock-origin.example",
      id: 2,
    };
    const other = {
      ...session,
      server_url: "https://another-mock-origin.example",
    };
    expect(await proxmoxEnableStorageImport(first, "pve", "local")).to.be.true;
    const storage = await proxmoxListStorage(renewed, "pve2");
    expect(storage[0].content).to.include("import");
    expect(await proxmoxEnableStorageImport(renewed, "pve2", "local")).to.be
      .false;
    expect((await proxmoxListStorage(other, "pve"))[0].content).not.to.include(
      "import"
    );
    expect(await proxmoxEnableStorageImport(other, "pve", "local")).to.be.true;
  });
});
