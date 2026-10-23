import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import type WaSelect from "@home-assistant/webawesome/dist/components/select/select.js";
import type { ProxmoxStorage } from "../../../../src/api/types.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/proxmox/proxmox-configure-view.js";
import type { ProxmoxConfigureView } from "../../../../src/views/proxmox/proxmox-configure-view.js";
import type { ProxmoxTargetLookup } from "../../../../src/views/proxmox/proxmox-target-lookup.js";
import { findByRole, fullA11ySnapshot } from "../../helpers/a11y.js";
import {
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

const withImport: ProxmoxStorage = {
  name: "local",
  storage_type: "dir",
  active: true,
  content: ["backup", "import"],
  available: 1e11,
};
const disk: ProxmoxStorage = {
  ...withImport,
  name: "local-lvm",
  storage_type: "lvmthin",
  content: ["images"],
};

/** What Proxmox refuses, as the backend sends it */
function refusal(key: string, params: Record<string, unknown> = {}) {
  return ipcError(
    "proxmox_action_required",
    "English from the backend",
    false,
    {
      message_key: `backend.proxmox.${key}`,
      message_params: params,
    }
  );
}

const vmIdTaken = "VM ID 100 can't be used. Choose a different ID.";
const tooSmall =
  'Not enough free space on "local-lvm" for the 32 GB disk (12 GB free).';
const badName =
  "Proxmox doesn't accept this VM name. Use letters, numbers, dashes and periods, and start and end with a letter or number.";

const lookupOf = (el: ProxmoxConfigureView) =>
  (el as unknown as { _lookup: ProxmoxTargetLookup })._lookup;
const focused = (el: ProxmoxConfigureView) => el.shadowRoot!.activeElement;
const focusAlerts = (el: ProxmoxConfigureView) =>
  el.shadowRoot!.querySelectorAll("[data-focus-alert], [role=alert]");
const vmIdOf = (el: ProxmoxConfigureView) =>
  el.shadowRoot!.querySelector<WaInput>("#vm-id")!;
const nameOf = (el: ProxmoxConfigureView) =>
  el.shadowRoot!.querySelector<WaInput>('wa-input[label="Display name"]')!;
const storageOf = (el: ProxmoxConfigureView) =>
  el.shadowRoot!.querySelector<WaSelect>("#storage")!;
const configureReady = () =>
  wizardState.getState().selections.proxmoxConfigureReady;

/** The accessibility node of the field named `name` */
async function fieldNamed(role: string, name: string) {
  return findByRole(await fullA11ySnapshot(), role).find(
    (node) => node.name === name
  )!;
}

describe("proxmox-configure-view check errors", () => {
  let check: () => unknown;

  beforeEach(() => {
    wizardState.startFlow("proxmox");
    wizardState.setSelection("proxmoxSession", {
      server_url: "https://pve.example:8006",
      ticket: "ticket",
      csrf_token: "csrf",
    });
    check = () => null;
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "proxmox_list_nodes":
          return [{ name: "pve", status: "online" }];
        case "proxmox_get_next_vm_id":
          return 100;
        case "proxmox_list_storage":
          return [withImport, disk];
        case "proxmox_list_bridges":
          return [
            {
              name: "vmbr0",
              network_type: "bridge",
              vlan_aware: false,
              comments: null,
            },
          ];
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
      () => !lookupOf(el).loadingNodes && !lookupOf(el).loadingStorage,
      "the lookups never finished"
    );
    await settle();
    await el.updateComplete;
    return el;
  }

  it("says at the VM ID that Proxmox can't use it, and focuses it", async () => {
    check = () => {
      throw refusal("vm_id_unavailable", { vm_id: 100 });
    };
    const el = await mount();

    expect(await el.check()).to.be.false;
    const vmId = vmIdOf(el);
    expect(focused(el)).to.equal(vmId);
    expect(vmId.hasAttribute("custom-error")).to.be.true;
    expect(
      el.shadowRoot!.querySelector(".vm-id-hint")!.textContent!.trim()
    ).to.equal(vmIdTaken);
    // Not said again below the form
    expect(focusAlerts(el)).to.have.length(0);
    const field = await fieldNamed("spinbutton", "VM ID");
    expect(field.invalid).to.equal("true");
    expect(field.description).to.equal(vmIdTaken);
  });

  it("says at the storage that it is too small, and focuses it", async () => {
    check = () => {
      throw refusal("storage_too_small", {
        storage: "local-lvm",
        size_gb: 32,
        free_gb: 12,
      });
    };
    const el = await mount();

    expect(await el.check()).to.be.false;
    const storage = storageOf(el);
    expect(focused(el)).to.equal(storage);
    expect(storage.hasAttribute("custom-error")).to.be.true;
    const hint = storage.querySelector('[slot="hint"]')!;
    expect(hint.textContent!.trim()).to.equal(tooSmall);
    expect(focusAlerts(el)).to.have.length(0);
    const field = await fieldNamed("combobox", "Storage");
    expect(field.invalid).to.equal("true");
    expect(field.description).to.equal(tooSmall);
  });

  it("says at the name that Proxmox refuses it, and focuses it", async () => {
    check = () => {
      throw refusal("invalid_vm_name");
    };
    const el = await mount();

    expect(await el.check()).to.be.false;
    const name = nameOf(el);
    expect(focused(el)).to.equal(name);
    expect(name.hasAttribute("custom-error")).to.be.true;
    expect(
      el.shadowRoot!.querySelector(".name-hint")!.textContent!.trim()
    ).to.equal(badName);
    expect(focusAlerts(el)).to.have.length(0);
    // Next can check again, as what Proxmox refuses can change
    expect(configureReady()).to.be.true;
  });

  it("says below the form what is no setting's, which takes the focus", async () => {
    check = () => {
      throw refusal("missing_privileges", {
        privileges: "VM.Allocate",
        path: "/vms/100",
      });
    };
    const el = await mount();

    expect(await el.check()).to.be.false;
    const [alert] = focusAlerts(el);
    expect(alert.textContent!.trim()).to.equal(
      "Your Proxmox user is missing VM.Allocate on /vms/100."
    );
    expect(focused(el)).to.equal(alert);
    expect(el.shadowRoot!.querySelectorAll("[custom-error]")).to.have.length(0);
  });

  it("drops a field's error once it changes", async () => {
    check = () => {
      throw refusal("vm_id_unavailable", { vm_id: 100 });
    };
    const el = await mount();
    expect(await el.check()).to.be.false;

    const vmId = vmIdOf(el);
    vmId.value = "101";
    vmId.dispatchEvent(new Event("input"));
    await el.updateComplete;
    await vmId.updateComplete;
    expect(vmId.hasAttribute("custom-error")).to.be.false;
    expect(
      el.shadowRoot!.querySelector(".vm-id-hint")!.textContent!.trim()
    ).to.equal("Unique identifier for the virtual machine");
    expect(configureReady()).to.be.true;
  });

  it("drops the storage's error once another storage is chosen", async () => {
    check = () => {
      throw refusal("storage_too_small", {
        storage: "local-lvm",
        size_gb: 32,
        free_gb: 12,
      });
    };
    const el = await mount();
    expect(await el.check()).to.be.false;

    const storage = storageOf(el);
    storage.value = "local";
    storage.dispatchEvent(new Event("change"));
    await el.updateComplete;
    await storage.updateComplete;
    expect(storage.hasAttribute("custom-error")).to.be.false;
    expect(storage.querySelector('[slot="hint"]')).to.be.null;
  });

  it("leaves the focus alone when the settings changed during the check", async () => {
    let answer!: () => void;
    check = () =>
      new Promise((_, reject) => {
        answer = () => reject(refusal("vm_id_unavailable", { vm_id: 100 }));
      });
    const el = await mount();
    const checked = el.check();
    await settle();

    const name = nameOf(el);
    name.focus();
    name.value = "home";
    name.dispatchEvent(new Event("input"));
    answer();

    expect(await checked).to.be.false;
    await el.updateComplete;
    expect(focused(el)).to.equal(name);
    expect(vmIdOf(el).hasAttribute("custom-error")).to.be.false;
  });
});
