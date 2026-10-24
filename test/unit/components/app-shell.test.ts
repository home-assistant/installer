import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import { emit } from "@tauri-apps/api/event";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import type { LitElement } from "lit";
import "../../../src/components/app-shell.js";
import type { AppShell } from "../../../src/components/app-shell.js";
import type { ConfirmDialog } from "../../../src/components/confirm-dialog.js";
import type { InfoDialog } from "../../../src/components/info-dialog.js";
import {
  MOCK_BLOCK_DEVICES,
  MOCK_MANIFEST,
} from "../../../src/api/mock-data.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import { storeDriveSelection } from "../../../src/utils/drive-selection.js";
import { fireEvent } from "../../../src/utils/fire-event.js";
import { flush, holdDeviceScan } from "../helpers/hold-device-scan.js";
import { showsError } from "../helpers/progress-error.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../tauri-ipc.js";

// Browser-only mode (no Tauri) serves MOCK_BLOCK_DEVICES, so this is the drive
// that is "connected" for the duration of these tests.
const CONNECTED = MOCK_BLOCK_DEVICES[0];

interface WizardShell extends HTMLElement {
  flowTitle: string;
  nextLabel: string;
  nextDisabled: boolean;
  nextBusy: boolean;
  hideFooter: boolean;
  hideBack: boolean;
  hideNext: boolean;
  hideCancel: boolean;
  updateComplete: Promise<boolean>;
}

interface ErrorFlags {
  _installError: boolean;
}

/** Web Awesome's own event, which `fireEvent` doesn't know */
function afterHide(dialog: Element) {
  dialog.dispatchEvent(
    new CustomEvent("wa-after-hide", { bubbles: true, composed: true })
  );
}

const shellOf = (el: AppShell) =>
  el.shadowRoot!.querySelector("wizard-shell") as WizardShell;

const dialogOf = (el: AppShell) =>
  el.shadowRoot!.querySelector("confirm-dialog") as ConfirmDialog;

async function waitForDialogOpen(el: AppShell) {
  await waitUntil(
    () =>
      !!dialogOf(el)
        .shadowRoot?.querySelector("wa-dialog")
        ?.shadowRoot?.querySelector("dialog")?.open
  );
}

async function finishDialogHide(el: AppShell) {
  await el.updateComplete;
  await dialogOf(el).updateComplete;
  // Model the overlay lifecycle here; both browser engines test the actual close.
  afterHide(dialogOf(el).shadowRoot!.querySelector("wa-dialog")!);
  await flush();
}

/** Pick a device and a drive, as the two selection steps would. */
function selectTargets({ withBoard = true } = {}) {
  wizardState.setSelection("device", "rpi5");
  wizardState.setSelection("deviceName", "Raspberry Pi 5");
  if (withBoard) {
    wizardState.setSelection("deviceConfig", MOCK_MANIFEST.devices[0].haos);
  }
  storeDriveSelection(CONNECTED);
}

/** Have the flash fail with `code` before it reaches the drive. */
function failFlash(code: string) {
  mockTauriIpc((cmd) => {
    if (cmd === "flash_image") return Promise.reject(ipcError(code, "Failed"));
    throw new Error(`Unexpected IPC command: ${cmd}`);
  });
}

async function goToStep(el: AppShell, id: string) {
  wizardState.goToStep(
    wizardState.getState().steps.findIndex((step) => step.id === id)
  );
  await el.updateComplete;
}

/** Open the Proxmox settings, with `check` answering the settings check. */
async function enterProxmoxConfigure(
  el: AppShell,
  check: () => Promise<unknown>
) {
  fireEvent(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
    view: "path-selection",
  });
  await el.updateComplete;
  fireEvent(
    el.shadowRoot!.querySelector("path-selection-view")!,
    "select-path",
    {
      path: "proxmox",
    }
  );
  await el.updateComplete;
  wizardState.setSelection("proxmoxSession", {
    server_url: "https://pve:8006",
    ticket: "test",
    csrf_token: "test",
  });
  mockTauriIpc((cmd) => {
    if (cmd === "proxmox_list_nodes")
      return [{ name: "pve", status: "online" }];
    if (cmd === "proxmox_get_next_vm_id") return 100;
    if (cmd === "proxmox_list_storage")
      return [
        {
          name: "local",
          active: true,
          content: ["images", "import"],
          available: 100,
        },
      ];
    if (cmd === "proxmox_list_bridges")
      return [{ name: "vmbr0", network_type: "bridge", comments: null }];
    if (cmd === "proxmox_check_vm_config") return check();
    throw new Error(cmd);
  });
  await goToStep(el, "configure");
  await waitUntil(() => !shellOf(el).nextDisabled);
}

/** Walk in through the real welcome → path-selection → wizard route. */
async function enterSbcFlow(el: AppShell) {
  fireEvent(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
    view: "path-selection",
  });
  await el.updateComplete;
  fireEvent(
    el.shadowRoot!.querySelector("path-selection-view")!,
    "select-path",
    {
      path: "sbc",
    }
  );
  await waitUntil(() => !!shellOf(el));
}

describe("app-shell", () => {
  let el: AppShell;

  beforeEach(async () => {
    wizardState.reset();
    el = await fixture<AppShell>(html`<app-shell></app-shell>`);
  });

  afterEach(async () => {
    // A mock flash keeps running after teardown. The detached tree still has
    // app-shell as an ancestor, so drop the wizard subtree: otherwise a late
    // "complete" would advance the shared wizard state under a later test.
    el.shadowRoot?.querySelector("wizard-shell")?.remove();
    el.remove();
    await settle();
    wizardState.reset();
    restoreTauriIpc();
  });

  it("keeps Next disabled until restored Proxmox choices have been verified", async () => {
    fireEvent(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
      view: "path-selection",
    });
    await el.updateComplete;
    fireEvent(
      el.shadowRoot!.querySelector("path-selection-view")!,
      "select-path",
      {
        path: "proxmox",
      }
    );
    await el.updateComplete;
    wizardState.setSelection("proxmoxSession", {
      server_url: "https://pve:8006",
      ticket: "test",
      csrf_token: "test",
    });
    wizardState.setSelection("proxmoxNode", "pve");
    wizardState.setSelection("proxmoxStorage", "local");
    wizardState.setSelection("proxmoxConfigureReady", true);
    const storage = deferred<unknown>();
    mockTauriIpc((cmd) => {
      if (cmd === "proxmox_list_nodes")
        return [{ name: "pve", status: "online" }];
      if (cmd === "proxmox_get_next_vm_id") return 100;
      if (cmd === "proxmox_list_storage") return storage.promise;
      if (cmd === "proxmox_list_bridges")
        return [{ name: "vmbr0", network_type: "bridge", comments: null }];
      throw new Error(cmd);
    });
    await goToStep(el, "configure");
    await waitUntil(() => shellOf(el).nextDisabled);
    expect(wizardState.getState().selections.proxmoxStorage).to.equal("local");
    storage.reject({
      message: "Temporary failure",
      code: "proxmox_api",
      retryable: true,
      details: {},
    });
    await waitUntil(
      () =>
        !!el
          .shadowRoot!.querySelector("proxmox-configure-view")!
          .shadowRoot!.querySelector("[data-focus-alert]")
    );
    expect(shellOf(el).nextDisabled).to.be.true;
    mockTauriIpc((cmd) => {
      if (cmd === "proxmox_list_nodes")
        return [{ name: "pve", status: "online" }];
      if (cmd === "proxmox_get_next_vm_id") return 100;
      if (cmd === "proxmox_list_storage")
        return [
          {
            name: "local",
            active: true,
            content: ["images", "import"],
            available: 100,
          },
        ];
      if (cmd === "proxmox_list_bridges")
        return [{ name: "vmbr0", network_type: "bridge", comments: null }];
      throw new Error(cmd);
    });
    (
      el
        .shadowRoot!.querySelector("proxmox-configure-view")!
        .shadowRoot!.querySelector("wa-button") as HTMLElement
    ).click();
    await waitUntil(() => !shellOf(el).nextDisabled);
  });

  it("stays on the Proxmox settings while Proxmox would reject them", async () => {
    let check = deferred<unknown>();
    await enterProxmoxConfigure(el, () => check.promise);

    fireEvent(shellOf(el), "wizard-next");
    await waitUntil(() => shellOf(el).nextLabel === "Checking settings...");
    // Busy rather than disabled, so it keeps the focus
    expect(shellOf(el).nextBusy).to.be.true;
    expect(shellOf(el).nextDisabled).to.be.false;
    // Nothing else sends the step on meanwhile either
    fireEvent(shellOf(el), "wizard-next");
    check.reject(
      ipcError(
        "proxmox_action_required",
        "VM ID 100 can't be used. Choose a different ID."
      )
    );
    await waitUntil(() => !shellOf(el).nextBusy);
    expect(wizardState.currentStep!.id).to.equal("configure");
    expect(
      shellOf(el)
        .querySelector("proxmox-configure-view")!
        .shadowRoot!.querySelector("[data-focus-alert]")!.textContent
    ).to.contain("VM ID 100 can't be used.");

    check = deferred<unknown>();
    fireEvent(shellOf(el), "wizard-next");
    check.resolve(null);
    await waitUntil(() => wizardState.currentStep?.id === "confirm");
  });

  it("leaves a settings check behind when the user goes back", async () => {
    const check = deferred<unknown>();
    await enterProxmoxConfigure(el, () => check.promise);
    fireEvent(shellOf(el), "wizard-next");
    await waitUntil(() => shellOf(el).nextLabel === "Checking settings...");

    wizardState.previousStep();
    await goToStep(el, "configure");
    await waitUntil(() => !shellOf(el).nextDisabled);
    expect(shellOf(el).nextBusy).to.be.false;
    expect(shellOf(el).nextLabel).not.to.equal("Checking settings...");

    check.resolve(null);
    await settle();
    expect(wizardState.currentStep!.id).to.equal("configure");
  });

  it("keeps a settings check when an edit leaves the settings as they were", async () => {
    const check = deferred<unknown>();
    await enterProxmoxConfigure(el, () => check.promise);
    fireEvent(shellOf(el), "wizard-next");
    await waitUntil(() => shellOf(el).nextLabel === "Checking settings...");

    // Every edit saves all settings again; a leading zero keeps the VM ID
    const vmId = shellOf(el)
      .querySelector("proxmox-configure-view")!
      .shadowRoot!.querySelector<WaInput>('wa-input[type="number"]')!;
    const saved = wizardState.getState().selections;
    vmId.value = `0${vmId.value}`;
    vmId.dispatchEvent(new Event("input"));
    await el.updateComplete;
    expect(wizardState.getState().selections === saved).to.be.true;
    expect(shellOf(el).nextLabel).to.equal("Checking settings...");

    check.resolve(null);
    await waitUntil(() => wizardState.currentStep?.id === "confirm");
  });

  for (const [flow, step] of [
    ["sbc", "device"],
    ["ha-hardware", "device"],
    ["minipc", "architecture"],
  ] as const) {
    it(`requires a refreshed catalog before leaving the ${flow} device picker`, async () => {
      await enterSbcFlow(el);
      if (flow !== "sbc") wizardState.startFlow(flow);
      await goToStep(el, step);
      await waitUntil(
        () => wizardState.getState().selections.deviceCatalogReady === true
      );
      // Picking a device goes on, so the step has no Next to hold
      expect(shellOf(el).hideNext).to.equal(true);
      const view = shellOf(el).firstElementChild!;

      wizardState.setSelection("device", "saved-device");
      wizardState.setSelection("deviceCatalogReady", false);
      fireEvent(view, "wizard-next");
      await settle();
      expect(wizardState.currentStep!.id).to.equal(step);

      wizardState.setSelection("deviceCatalogReady", true);
      wizardState.setSelection("device", undefined);
      fireEvent(view, "wizard-next");
      await settle();
      expect(wizardState.currentStep!.id).to.equal(step);
      expect(shellOf(el).nextBusy).to.equal(false);
    });
  }

  it("names the flow in the wizard's main heading", async () => {
    await enterSbcFlow(el);
    for (const [flow, title] of [
      ["sbc", "Raspberry Pi & other boards"],
      ["minipc", "Mini PC or other computer"],
      ["ha-hardware", "Home Assistant hardware"],
      ["proxmox", "Proxmox server"],
      ["vm", "Virtual machine"],
    ] as const) {
      wizardState.startFlow(flow);
      await el.updateComplete;
      expect(shellOf(el).flowTitle).to.equal(title);
    }
  });

  it("puts each screen before a flow in the main landmark", async () => {
    // The welcome screen has a footer of its own, outside it
    const welcome = el.shadowRoot!.querySelector("welcome-view")!;
    expect(welcome.shadowRoot!.querySelector("main h1")).to.exist;
    expect(welcome.shadowRoot!.querySelector("main footer")).to.be.null;

    fireEvent(welcome, "navigate", { view: "path-selection" });
    await el.updateComplete;
    expect(
      el.shadowRoot!.querySelector("path-selection-view")!.getAttribute("role")
    ).to.equal("main");

    fireEvent(
      el.shadowRoot!.querySelector("path-selection-view")!,
      "navigate",
      {
        view: "other-options",
      }
    );
    await el.updateComplete;
    expect(
      el.shadowRoot!.querySelector("other-options-view")!.getAttribute("role")
    ).to.equal("main");
  });

  describe("connection gate", () => {
    it("starts the selected flow only after a successful retry", async () => {
      const retry = deferred<void>();
      let calls = 0;
      mockTauriIpc((command) => {
        expect(command).to.equal("check_connection");
        return ++calls === 1
          ? Promise.reject(
              "Cannot reach version.home-assistant.io. Check your internet connection and try again."
            )
          : retry.promise;
      });
      fireEvent(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
        view: "path-selection",
      });
      await el.updateComplete;
      fireEvent(
        el.shadowRoot!.querySelector("path-selection-view")!,
        "select-path",
        { path: "proxmox" }
      );
      await waitUntil(
        () =>
          !!el
            .shadowRoot!.querySelector("connection-check-view")
            ?.shadowRoot?.querySelector("[data-focus-alert]")
      );
      const gate = el.shadowRoot!.querySelector("connection-check-view")!;
      expect(wizardState.getState().currentFlow).to.equal(null);
      (
        gate.shadowRoot!.querySelector(
          'wa-button[variant="brand"]'
        ) as HTMLElement
      ).click();
      await settle();
      expect(wizardState.getState().currentFlow).to.equal(null);
      retry.resolve();
      await waitUntil(() => !!shellOf(el));
      expect(wizardState.getState().currentFlow).to.equal("proxmox");
      expect(shellOf(el).querySelector("proxmox-connect-view")).to.exist;
      expect(calls).to.equal(2);
    });

    for (const path of [
      "sbc",
      "minipc",
      "ha-hardware",
      "vm",
      "proxmox",
    ] as const) {
      it(`checks connectivity before starting ${path} and allows Back`, async () => {
        const pending = deferred<void>();
        const calls: string[] = [];
        mockTauriIpc((command) => {
          // The path selection asks on a Mac; that's not part of the gate
          if (command === "utm_supported") return true;
          calls.push(command);
          return pending.promise;
        });
        fireEvent(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
          view: "path-selection",
        });
        await el.updateComplete;
        fireEvent(
          el.shadowRoot!.querySelector("path-selection-view")!,
          "select-path",
          { path }
        );
        await waitUntil(() => calls.length === 1);
        expect(calls).to.deep.equal(["check_connection"]);
        expect(wizardState.getState().currentFlow).to.equal(null);
        expect(shellOf(el)).to.equal(null);
        const gate = el.shadowRoot!.querySelector("connection-check-view")!;
        (gate.shadowRoot!.querySelector("wa-button") as HTMLElement).click();
        await el.updateComplete;
        pending.resolve();
        await settle();
        expect(el.shadowRoot!.querySelector("path-selection-view")).to.exist;
        expect(wizardState.getState().currentFlow).to.equal(null);
      });
    }
  });

  // The welcome screen has nothing new for someone who already used it
  for (const [action, event, step] of [
    ["Back leaves the first step", "wizard-exit", undefined],
    ["Cancel is chosen", "wizard-cancel", undefined],
    ["Done is chosen", "wizard-next", "done"],
  ] as const) {
    it(`returns to path selection when ${action}`, async () => {
      await enterSbcFlow(el);
      wizardState.setSelection("device", "rpi5");
      if (step) await goToStep(el, step);

      fireEvent(shellOf(el), event);
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector("path-selection-view")).to.exist;
      expect(shellOf(el)).to.equal(null);
      expect(wizardState.getState().currentFlow).to.equal(null);
      expect(wizardState.getState().selections).to.deep.equal({});
    });
  }

  it("offers only Done once the installation succeeded", async () => {
    await enterSbcFlow(el);
    expect(shellOf(el).hideCancel).to.be.false;

    await goToStep(el, "done");
    expect(shellOf(el).hideCancel).to.be.true;
    expect(shellOf(el).nextLabel).to.equal("Done");
  });

  // Back would write the drive again
  it("offers no Back once the drive is written", async () => {
    await enterSbcFlow(el);
    await goToStep(el, "success");
    expect(shellOf(el).hideBack).to.be.true;
    expect(shellOf(el).hideCancel).to.be.false;
    expect(shellOf(el).nextLabel).to.equal("Next");
  });

  it("skips the wait for Home Assistant to where to find it", async () => {
    await enterSbcFlow(el);
    await goToStep(el, "setup");
    expect(shellOf(el).nextLabel).to.equal("Skip");
    // Back to how to start the device, which can be read again
    expect(shellOf(el).hideBack).to.be.false;

    fireEvent(shellOf(el), "wizard-next");
    await el.updateComplete;
    expect(wizardState.currentStep?.id).to.equal("done");
    expect(shellOf(el).querySelector("device-done-view")).to.exist;
  });

  // The first click changes the screen, and the second lands on whatever the
  // next screen has in that spot
  describe("double-click", () => {
    /** Click `target` as the `detail`th click in a row; keys give 0. */
    function click(target: Element, detail: number) {
      target.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          composed: true,
          cancelable: true,
          detail,
        })
      );
    }

    const viewOf = (el: AppShell, name: string) =>
      el.shadowRoot!.querySelector(name) as LitElement;

    it("on Back on the first step stops at the path selection", async () => {
      await enterSbcFlow(el);

      click(shellOf(el).shadowRoot!.querySelector(".header wa-button")!, 1);
      await el.updateComplete;
      // The path selection has its own Back in the same spot
      const paths = viewOf(el, "path-selection-view");
      await paths.updateComplete;
      click(paths.shadowRoot!.querySelector(".header wa-button")!, 2);
      await el.updateComplete;

      expect(!!viewOf(el, "path-selection-view")).to.be.true;
      expect(!!viewOf(el, "welcome-view")).to.be.false;
    });

    it("on connecting the drive picks no architecture", async () => {
      await enterSbcFlow(el);
      wizardState.startFlow("minipc");
      await el.updateComplete;
      const method = shellOf(el).querySelector(
        "minipc-setup-method-view"
      ) as LitElement;
      await method.updateComplete;

      click(method.shadowRoot!.querySelector("option-card")!, 1);
      await el.updateComplete;
      const architectures = shellOf(el).querySelector(
        "minipc-architecture-selection-view"
      )!;
      await waitUntil(
        () =>
          architectures.shadowRoot!.querySelectorAll("option-card").length > 0
      );
      // The architectures open where the card was
      click(architectures.shadowRoot!.querySelector("option-card")!, 2);
      await settle();

      expect(wizardState.currentStep!.id).to.equal("architecture");
      expect(wizardState.getState().selections.device).to.equal(undefined);
    });

    it("leaves the keyboard alone", async () => {
      await enterSbcFlow(el);

      click(shellOf(el).shadowRoot!.querySelector(".header wa-button")!, 1);
      await el.updateComplete;
      const paths = viewOf(el, "path-selection-view");
      await paths.updateComplete;
      click(paths.shadowRoot!.querySelector(".header wa-button")!, 0);
      await el.updateComplete;

      expect(!!viewOf(el, "welcome-view")).to.be.true;
    });

    it("still counts on a screen that stays", async () => {
      const welcome = viewOf(el, "welcome-view");
      const logo = welcome.shadowRoot!.querySelector(".logo-container")!;

      click(logo, 1);
      click(logo, 2);

      // The logo plays a sound after five clicks in a row
      expect(
        (welcome as unknown as { _logoClickCount: number })._logoClickCount
      ).to.equal(2);
    });
  });

  it("does not hold up a new flow with a Proxmox connect left behind", async () => {
    const fingerprint = deferred<string | null>();
    mockTauriIpc((cmd) => {
      if (cmd === "check_connection") return undefined;
      if (cmd === "proxmox_certificate_fingerprint") return fingerprint.promise;
      throw new Error(cmd);
    });
    const enterProxmox = async () => {
      fireEvent(
        el.shadowRoot!.querySelector("path-selection-view")!,
        "select-path",
        {
          path: "proxmox",
        }
      );
      await waitUntil(
        () => !!shellOf(el)?.querySelector("proxmox-connect-view")
      );
    };
    fireEvent(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
      view: "path-selection",
    });
    await el.updateComplete;
    await enterProxmox();
    Object.assign(shellOf(el).querySelector("proxmox-connect-view")!, {
      _serverUrl: "https://pve:8006",
      _password: "test",
    });

    fireEvent(shellOf(el), "wizard-next");
    await waitUntil(() => shellOf(el).nextBusy);
    expect(shellOf(el).nextLabel).to.equal("Connecting...");
    expect(shellOf(el).nextDisabled).to.be.false;
    fireEvent(shellOf(el), "wizard-exit");
    await el.updateComplete;
    await enterProxmox();

    expect(shellOf(el).nextBusy).to.be.false;
    expect(shellOf(el).nextLabel).to.equal("Next");
    fingerprint.resolve(null);
    await settle();
    expect(wizardState.currentStep?.id).to.equal("connection");
  });

  it("asks before erasing the drive for a Home Assistant hardware installer", async () => {
    await enterSbcFlow(el);
    wizardState.startFlow("ha-hardware");
    wizardState.setSelection("device", "ha-green");
    wizardState.setSelection("haHardware", "green");
    wizardState.setSelection("deviceConfig", {
      board: "green-installer",
      minimum_storage_bytes: 1_000_000_000,
      recommended_storage_bytes: 1_000_000_000,
    });
    storeDriveSelection(CONNECTED);
    await goToStep(el, "confirm");
    expect(shellOf(el).querySelector("confirmation-view")).to.exist;

    fireEvent(shellOf(el), "wizard-next");
    await waitForDialogOpen(el);
    fireEvent(dialogOf(el), "dialog-primary");
    await finishDialogHide(el);
    await waitUntil(() => wizardState.currentStep?.id === "flash");
    expect(shellOf(el).querySelector("progress-view")).to.exist;
  });

  it("holds Next on the drive step until the drives are scanned again", async () => {
    await enterSbcFlow(el);
    selectTargets();
    await goToStep(el, "wifi");
    const scan = holdDeviceScan();
    try {
      wizardState.previousStep();
      await el.updateComplete;
      expect(wizardState.currentStep!.id).to.equal("drive");
      expect(shellOf(el).nextDisabled).to.be.true;

      scan.resolve(MOCK_BLOCK_DEVICES);
      await waitUntil(() => !shellOf(el).nextDisabled, "Next stayed disabled");
      expect(wizardState.getState().selections.drive).to.equal(CONNECTED.id);
    } finally {
      scan.restore();
    }
  });

  describe("steps that go on when a card is picked", () => {
    const view = () => shellOf(el).firstElementChild as LitElement;
    const card = (selector: string) =>
      view().shadowRoot!.querySelector<HTMLElement>(selector)!;

    it("show no Next, where the drive step keeps it", async () => {
      await enterSbcFlow(el);
      await el.updateComplete;
      expect(shellOf(el).hideNext).to.be.true;

      await goToStep(el, "drive");
      expect(shellOf(el).hideNext).to.be.false;
    });

    it("goes on to the drive once a board is picked", async () => {
      await enterSbcFlow(el);
      await waitUntil(() => view().shadowRoot?.querySelector("device-card"));

      card('device-card[value="rpi4"]').click();
      await el.updateComplete;

      expect(wizardState.currentStep!.id).to.equal("drive");
      expect(wizardState.getState().selections.device).to.equal("rpi4");
    });

    it("goes on from the compute module the Yellow has", async () => {
      await enterSbcFlow(el);
      wizardState.startFlow("ha-hardware");
      wizardState.setSelection("device", "ha-yellow");
      wizardState.setSelection("yellowModules", [
        { id: "yellow-cm4", config: MOCK_MANIFEST.devices[0].haos },
        { id: "yellow-cm5", config: MOCK_MANIFEST.devices[0].haos },
      ]);
      await goToStep(el, "module");
      expect(shellOf(el).hideNext).to.equal(true);

      card('option-card[value="yellow-cm5"]').click();
      await el.updateComplete;

      expect(wizardState.currentStep!.id).to.equal("drive");
      expect(wizardState.getState().selections.haHardware).to.equal(
        "yellow-cm5"
      );
    });

    // Each on a fresh pick: picked again while the question still animates
    // out, the question that closed would close the new one too
    for (const [answer, step] of [
      ["dialog-secondary", "device"],
      ["dialog-primary", "drive"],
    ] as const) {
      it(`asks before reinstalling the hardware picked, and ${answer === "dialog-primary" ? "goes on on Reinstall" : "stays on Go back"}`, async () => {
        await enterSbcFlow(el);
        wizardState.startFlow("ha-hardware");
        await el.updateComplete;
        await waitUntil(() => view().shadowRoot?.querySelector("device-card"));
        // Rendered once a device is chosen
        const question = () =>
          view().shadowRoot!.querySelector<InfoDialog>("info-dialog");

        card('device-card[value="ha-green"]').click();
        await waitUntil(() => question()?.open, "never asked");
        fireEvent(question()!, answer);
        await settle();
        expect(wizardState.currentStep!.id).to.equal(step);
      });
    }
  });

  describe("selected drive check before erasing", () => {
    beforeEach(async () => {
      await enterSbcFlow(el);
      selectTargets();
      await goToStep(el, "confirm");
    });

    it("writes to the drive when it is still connected", async () => {
      fireEvent(shellOf(el), "wizard-next");
      await waitForDialogOpen(el);

      fireEvent(dialogOf(el), "dialog-primary");
      expect(wizardState.currentStep!.id).to.equal("confirm");
      await finishDialogHide(el);

      await waitUntil(
        () => wizardState.currentStep?.id === "flash",
        "never reached the write step"
      );
      afterHide(dialogOf(el).shadowRoot!.querySelector("wa-dialog")!);
      await flush();
      expect(wizardState.currentStep!.id).to.equal("flash");
    });

    it("does not advance if the selected configuration changes while the dialog closes", async () => {
      fireEvent(shellOf(el), "wizard-next");
      await waitForDialogOpen(el);
      fireEvent(dialogOf(el), "dialog-primary");
      wizardState.setSelection("device", "different-device");
      await finishDialogHide(el);
      expect(wizardState.currentStep!.id).to.equal("confirm");
    });

    it("does not advance after cancelling the dialog", async () => {
      fireEvent(shellOf(el), "wizard-next");
      await waitForDialogOpen(el);
      fireEvent(dialogOf(el), "dialog-secondary");
      await finishDialogHide(el);
      expect(wizardState.currentStep!.id).to.equal("confirm");
    });

    it("returns to drive selection when the path names a different disk", async () => {
      wizardState.setSelection("driveModel", "A Completely Different Stick");

      fireEvent(shellOf(el), "wizard-next");

      await waitUntil(
        () => wizardState.getState().selections.drive === undefined,
        "stale selection was never cleared"
      );
      expect(wizardState.currentStep!.id).to.equal("drive");
      expect(dialogOf(el).hasAttribute("open")).to.be.false;
    });

    it("explains going back when the drive could not be checked", async () => {
      // The check's scan fails, while the drive step's own scan finds the drive
      const scans = [deferred<unknown>(), deferred<unknown>()];
      let calls = 0;
      mockTauriIpc((cmd) => {
        if (cmd === "list_block_devices") return scans[calls++].promise;
        throw new Error(cmd);
      });
      fireEvent(shellOf(el), "wizard-next");
      await waitUntil(() => shellOf(el).nextLabel === "Checking drive...");
      scans[0].reject(ipcError("operation_failed", "Scan failed"));
      await waitUntil(() => wizardState.currentStep?.id === "drive");
      await el.updateComplete;

      // Picking the drive again is up to the user, not Next
      expect(wizardState.getState().selections.drive).to.be.undefined;
      expect(shellOf(el).nextDisabled).to.be.true;
      scans[1].resolve(MOCK_BLOCK_DEVICES);
      const view = shellOf(el).querySelector("drive-selection-view")!;
      await waitUntil(
        () =>
          view.shadowRoot!.querySelector(
            '[role="status"] inline-notice[variant="error"]'
          ),
        "the drive step never said why"
      );
      expect(shellOf(el).nextDisabled).to.be.true;
      expect(dialogOf(el).hasAttribute("open")).to.be.false;
    });

    it("ignores a check that finishes after the user went back", async () => {
      const scan = holdDeviceScan();
      try {
        fireEvent(shellOf(el), "wizard-next");
        await waitUntil(() => shellOf(el).nextLabel === "Checking drive...");

        wizardState.previousStep();
        scan.resolve(MOCK_BLOCK_DEVICES);
        await flush();

        expect(dialogOf(el).hasAttribute("open")).to.be.false;
        // The step before Confirm, Wi-Fi for this board
        expect(wizardState.currentStep!.id).to.equal("wifi");
      } finally {
        scan.restore();
      }
    });

    it("keeps Install focusable while it checks the drive, once", async () => {
      const scan = holdDeviceScan();
      const tauri = (window as unknown as Record<string, unknown>)
        .__TAURI_INTERNALS__ as { invoke: () => unknown };
      const invoke = tauri.invoke;
      let scans = 0;
      tauri.invoke = () => {
        scans++;
        return invoke();
      };
      try {
        fireEvent(shellOf(el), "wizard-next");
        await waitUntil(() => shellOf(el).nextLabel === "Checking drive...");
        // Busy rather than disabled: the erase dialog then returns the focus
        // to it when cancelled
        expect(shellOf(el).nextBusy).to.be.true;
        expect(shellOf(el).nextDisabled).to.be.false;

        fireEvent(shellOf(el), "wizard-next");
        scan.resolve(MOCK_BLOCK_DEVICES);
        await waitForDialogOpen(el);
        expect(scans).to.equal(1);
        expect(shellOf(el).nextBusy).to.be.false;
        expect(shellOf(el).nextLabel).to.equal("Install");
      } finally {
        scan.restore();
      }
    });

    // The dialog can stay open for any length of time, so the device is
    // checked again on confirm.
    it("re-checks between opening the dialog and the write", async () => {
      fireEvent(shellOf(el), "wizard-next");
      await waitForDialogOpen(el);

      wizardState.setSelection("driveModel", "Swapped While You Read This");
      fireEvent(dialogOf(el), "dialog-primary");
      await finishDialogHide(el);

      await waitUntil(
        () => wizardState.currentStep?.id === "drive",
        "the write was not held back"
      );
    });

    it("rechecks the board minimum before erasing", async () => {
      fireEvent(shellOf(el), "wizard-next");
      await waitUntil(() => dialogOf(el).hasAttribute("open"));

      wizardState.setSelection("deviceConfig", {
        ...MOCK_MANIFEST.devices[0].haos,
        minimum_storage_bytes: CONNECTED.size * 2,
        recommended_storage_bytes: CONNECTED.size * 2,
      });
      fireEvent(dialogOf(el), "dialog-primary");
      await finishDialogHide(el);
      await waitUntil(() => wizardState.currentStep?.id === "drive");
      await waitUntil(
        () => wizardState.getState().selections.drive === undefined
      );
      expect(dialogOf(el).hasAttribute("open")).to.be.false;
    });
  });

  describe("Wi-Fi", () => {
    beforeEach(async () => {
      await enterSbcFlow(el);
      selectTargets();
    });

    it("keeps Next disabled until the network is complete", async () => {
      await goToStep(el, "wifi");
      expect(shellOf(el).querySelector("wifi-view")).to.exist;
      expect(shellOf(el).nextDisabled).to.be.false;
      wizardState.setSelection("wifi", { ssid: "Home", password: "" });
      await el.updateComplete;
      expect(shellOf(el).nextDisabled).to.be.true;
      wizardState.setSelection("wifi", { ssid: "Home", password: "12345678" });
      await el.updateComplete;
      expect(shellOf(el).nextDisabled).to.be.false;
    });

    it("ignores a network left over from a board with Wi-Fi", async () => {
      wizardState.setSelection("wifi", { ssid: "", password: "" });
      wizardState.setSelection(
        "deviceConfig",
        MOCK_MANIFEST.devices.find(
          (device) => device.haos.board === "odroid-n2"
        )!.haos
      );
      expect(
        wizardState.getState().steps.map((step) => step.id)
      ).not.to.include("wifi");
      await goToStep(el, "confirm");
      expect(shellOf(el).nextDisabled).to.be.false;
    });

    it("drops the password once it is on the drive", async () => {
      wizardState.setSelection("wifi", { ssid: "Home", password: "12345678" });
      await goToStep(el, "flash");
      fireEvent(shellOf(el), "install-complete");
      await el.updateComplete;
      expect(wizardState.currentStep?.id).to.equal("success");
      expect(wizardState.getState().selections.wifi).to.deep.equal({
        ssid: "Home",
        password: "",
      });
    });
  });

  // Browser-only mode runs the simulated flash, which honors a stop too
  describe("cancelling a running flash", () => {
    const stopDialogOf = (el: AppShell) =>
      el.shadowRoot!.querySelector("info-dialog.stop-dialog") as InfoDialog;

    beforeEach(async () => {
      await enterSbcFlow(el);
      selectTargets();
      await goToStep(el, "flash");
    });

    it("asks first, and Keep installing carries on", async () => {
      expect(shellOf(el).hideFooter).to.be.false;
      expect(shellOf(el).hideNext).to.be.true;

      fireEvent(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      expect(stopDialogOf(el).open).to.be.true;

      fireEvent(stopDialogOf(el), "dialog-secondary");
      await el.updateComplete;
      expect(stopDialogOf(el).open).to.be.false;
      expect(wizardState.currentStep?.id).to.equal("flash");
      expect(shellOf(el).hideFooter).to.be.false;
    });

    it("stops the flash and offers to install again", async () => {
      fireEvent(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      fireEvent(stopDialogOf(el), "dialog-primary");
      await el.updateComplete;
      // No buttons while the flash winds down
      expect(shellOf(el).hideFooter).to.be.true;

      await waitUntil(() => shellOf(el).nextLabel === "Try again");
      expect(shellOf(el).hideFooter).to.be.false;
      expect(wizardState.currentStep?.id).to.equal("flash");
      expect(showsError(el.shadowRoot!.querySelector("progress-view")!)).to.be
        .true;
    });
  });

  it("brings Cancel back when the stop request fails", async () => {
    await enterSbcFlow(el);
    selectTargets();
    mockTauriIpc((cmd) => {
      if (cmd === "cancel_flash")
        return Promise.reject(new Error("IPC unavailable"));
      // The flash keeps running
      return new Promise(() => {});
    });
    await goToStep(el, "flash");

    fireEvent(shellOf(el), "wizard-cancel");
    await el.updateComplete;
    fireEvent(
      el.shadowRoot!.querySelector("info-dialog.stop-dialog")!,
      "dialog-primary"
    );
    await settle();
    await el.updateComplete;

    expect(shellOf(el).hideFooter).to.be.false;
    expect(wizardState.currentStep?.id).to.equal("flash");
  });

  // "Try again" writes the same drive and Cancel drops every choice, so Back
  // is the way to change the drive or the Wi-Fi once the flash ended
  describe("Back after the flash ended", () => {
    /** Click Back in the header, as the user would. */
    async function clickBack(el: AppShell) {
      await shellOf(el).updateComplete;
      shellOf(el)
        .shadowRoot!.querySelector<HTMLElement>(".header wa-button")!
        .click();
      await el.updateComplete;
    }

    beforeEach(async () => {
      await enterSbcFlow(el);
    });

    it("returns to the confirmation once stopped, which asks again before erasing", async () => {
      selectTargets();
      await goToStep(el, "flash");
      expect(shellOf(el).hideBack).to.be.true;

      fireEvent(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      fireEvent(
        el.shadowRoot!.querySelector("info-dialog.stop-dialog")!,
        "dialog-primary"
      );
      await el.updateComplete;
      // Not while the flash winds down
      expect(shellOf(el).hideBack).to.be.true;
      await waitUntil(() => shellOf(el).nextLabel === "Try again");
      expect(shellOf(el).hideBack).to.be.false;

      await clickBack(el);
      expect(wizardState.currentStep?.id).to.equal("confirm");
      expect(shellOf(el).querySelector("progress-view")).to.equal(null);
      expect(shellOf(el).nextLabel).to.equal("Install");
      expect((el as unknown as ErrorFlags)._installError).to.be.false;

      fireEvent(shellOf(el), "wizard-next");
      await waitForDialogOpen(el);
      fireEvent(dialogOf(el), "dialog-primary");
      await finishDialogHide(el);
      await waitUntil(() => wizardState.currentStep?.id === "flash");
      await el.updateComplete;

      // A new write: Cancel only, nothing left over from the stopped one
      expect(shellOf(el).hideBack).to.be.true;
      expect(shellOf(el).hideNext).to.be.true;
      expect(shellOf(el).hideFooter).to.be.false;
    });

    it("is there beside Choose another drive", async () => {
      selectTargets();
      failFlash("drive_disconnected");
      await goToStep(el, "flash");
      await waitUntil(() => shellOf(el).nextLabel === "Choose another drive");
      expect(shellOf(el).hideBack).to.be.false;
      restoreTauriIpc();

      await clickBack(el);
      expect(wizardState.currentStep?.id).to.equal("confirm");
      expect((el as unknown as ErrorFlags)._installError).to.be.false;
    });

    // Another drive can't fix an unexpected response, so there is no Next
    it("is the way on when the drive is not what failed", async () => {
      selectTargets();
      failFlash("json");
      await goToStep(el, "flash");
      await waitUntil(() =>
        showsError(shellOf(el).querySelector("progress-view")!)
      );
      await el.updateComplete;
      expect(shellOf(el).hideNext).to.be.true;
      expect(shellOf(el).hideBack).to.be.false;
      expect(shellOf(el).hideFooter).to.be.false;
      restoreTauriIpc();

      await clickBack(el);
      expect(wizardState.currentStep?.id).to.equal("confirm");
      expect(shellOf(el).nextLabel).to.equal("Install");
    });
  });

  // The progress view says whether choosing differently can fix a failure
  // that trying again can't
  describe("Next after a failed flash", () => {
    beforeEach(async () => {
      await enterSbcFlow(el);
      selectTargets();
      // The flash keeps running until the test fails it
      mockTauriIpc(() => new Promise(() => {}));
      await goToStep(el, "flash");
    });

    async function fail(detail: { retryable: boolean; changeChoice: boolean }) {
      fireEvent(
        shellOf(el).querySelector("progress-view")!,
        "install-error",
        detail
      );
      await el.updateComplete;
    }

    it("leads to the drive step when the drive failed", async () => {
      await fail({ retryable: false, changeChoice: true });
      expect(shellOf(el).nextLabel).to.equal("Choose another drive");
      expect(shellOf(el).hideNext).to.be.false;

      fireEvent(shellOf(el), "wizard-next");
      await el.updateComplete;
      expect(wizardState.currentStep?.id).to.equal("drive");
    });

    it("tries the same drive again first when that can work", async () => {
      await fail({ retryable: true, changeChoice: true });
      expect(shellOf(el).nextLabel).to.equal("Try again");
    });

    it("is hidden when no choice can fix it", async () => {
      await fail({ retryable: false, changeChoice: false });
      expect(shellOf(el).hideNext).to.be.true;
      expect(shellOf(el).hideBack).to.be.false;

      // Nothing else sends the flash on to the drive step either
      fireEvent(shellOf(el), "wizard-next");
      await el.updateComplete;
      expect(wizardState.currentStep?.id).to.equal("flash");
    });
  });

  describe("cancelling a running VM install", () => {
    const stopDialogOf = (el: AppShell) =>
      el.shadowRoot!.querySelector("info-dialog.stop-dialog") as InfoDialog;

    /** `mockBackend` runs once the flow is entered, before the install starts */
    async function enterProxmoxInstall(mockBackend?: () => void) {
      fireEvent(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
        view: "path-selection",
      });
      await el.updateComplete;
      fireEvent(
        el.shadowRoot!.querySelector("path-selection-view")!,
        "select-path",
        { path: "proxmox" }
      );
      await el.updateComplete;
      wizardState.setSelection("proxmoxSession", {
        server_url: "https://pve:8006",
        ticket: "test",
        csrf_token: "test",
      });
      mockBackend?.();
      await goToStep(el, "install");
    }

    // Browser-only mode runs the simulated install, which honors a stop too
    it("asks first, then stops before anything is created", async () => {
      await enterProxmoxInstall();
      await waitUntil(() => !shellOf(el).hideFooter, "Cancel never showed");
      expect(shellOf(el).hideNext).to.be.true;

      fireEvent(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      expect(stopDialogOf(el).open).to.be.true;
      expect(stopDialogOf(el).message).to.contain("nothing is left behind");

      fireEvent(stopDialogOf(el), "dialog-primary");
      await waitUntil(() => shellOf(el).nextLabel === "Try again");
      expect(shellOf(el).hideFooter).to.be.false;
      expect(wizardState.currentStep?.id).to.equal("install");
      expect(showsError(el.shadowRoot!.querySelector("proxmox-progress-view")!))
        .to.be.true;
    });

    it("offers to leave once the VM runs, and leaves it running", async () => {
      const ready = deferred<boolean>();
      const calls: string[] = [];
      await enterProxmoxInstall(() =>
        mockTauriIpc((cmd) => {
          calls.push(cmd);
          if (cmd === "proxmox_create_vm") return { vm_id: 100, node: "pve" };
          if (cmd === "proxmox_get_vm_status")
            return { status: "running", ip_address: "192.0.2.50" };
          // Home Assistant is still starting
          if (cmd === "check_ha_ready") return ready.promise;
          throw new Error(`Unexpected IPC command: ${cmd}`);
        })
      );
      await waitUntil(
        () => calls.includes("check_ha_ready") && !shellOf(el).hideFooter,
        "Cancel never came back once the VM existed"
      );
      expect(shellOf(el).hideNext).to.be.true;
      const leaveDialog = el.shadowRoot!.querySelector(
        "info-dialog.leave-dialog"
      ) as InfoDialog;

      fireEvent(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      expect(leaveDialog.open).to.be.true;
      expect(stopDialogOf(el).open).to.be.false;
      expect(leaveDialog.heading).to.equal("Leave the installation?");
      expect(leaveDialog.message).to.contain("http://192.0.2.50");
      expect(leaveDialog.message).not.to.contain("Import");

      fireEvent(leaveDialog, "dialog-secondary");
      await el.updateComplete;
      expect(leaveDialog.open).to.be.false;
      expect(wizardState.currentStep?.id).to.equal("install");

      fireEvent(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      fireEvent(leaveDialog, "dialog-primary");
      await el.updateComplete;
      expect(el.shadowRoot!.querySelector("path-selection-view")).to.exist;
      expect(wizardState.getState().selections.proxmoxVmResult).to.be.undefined;
    });

    it("points to the name Home Assistant announces while the VM has no address", async () => {
      const calls: string[] = [];
      await enterProxmoxInstall(() =>
        mockTauriIpc((cmd) => {
          calls.push(cmd);
          if (cmd === "proxmox_create_vm") return { vm_id: 100, node: "pve" };
          if (cmd === "proxmox_get_vm_status")
            return { status: "running", ip_address: null };
          throw new Error(`Unexpected IPC command: ${cmd}`);
        })
      );
      await waitUntil(
        () =>
          calls.includes("proxmox_get_vm_status") && !shellOf(el).hideFooter,
        "Cancel never came back once the VM existed"
      );
      const leaveDialog = el.shadowRoot!.querySelector(
        "info-dialog.leave-dialog"
      ) as InfoDialog;

      fireEvent(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      expect(leaveDialog.open).to.be.true;
      expect(leaveDialog.message).to.contain("http://homeassistant.local");
    });

    // Import is cluster-wide and stays on, and only the success view would
    // remind of it otherwise
    describe("after this flow enabled Import", () => {
      const enableImport = () =>
        wizardState.setSelection("proxmoxImportChanges", [
          { serverOrigin: "https://pve:8006", storage: "local" },
        ]);

      it("says so before a stop", async () => {
        await enterProxmoxInstall(enableImport);
        await waitUntil(() => !shellOf(el).hideFooter, "Cancel never showed");

        fireEvent(shellOf(el), "wizard-cancel");
        await el.updateComplete;
        expect(stopDialogOf(el).open).to.be.true;
        expect(stopDialogOf(el).message).to.contain(
          'Import, which this installer enabled on "local", stays on'
        );
        expect(stopDialogOf(el).message).not.to.contain(
          "nothing is left behind"
        );
      });

      it("says so before leaving", async () => {
        const calls: string[] = [];
        await enterProxmoxInstall(() => {
          enableImport();
          mockTauriIpc((cmd) => {
            calls.push(cmd);
            if (cmd === "proxmox_create_vm") return { vm_id: 100, node: "pve" };
            if (cmd === "proxmox_get_vm_status")
              return { status: "running", ip_address: "192.0.2.50" };
            // Home Assistant is still starting
            if (cmd === "check_ha_ready") return new Promise(() => {});
            throw new Error(`Unexpected IPC command: ${cmd}`);
          });
        });
        await waitUntil(
          () => calls.includes("check_ha_ready") && !shellOf(el).hideFooter,
          "Cancel never came back once the VM existed"
        );
        const leaveDialog = el.shadowRoot!.querySelector(
          "info-dialog.leave-dialog"
        ) as InfoDialog;

        fireEvent(shellOf(el), "wizard-cancel");
        await el.updateComplete;
        expect(leaveDialog.open).to.be.true;
        expect(leaveDialog.message).to.contain("http://192.0.2.50");
        expect(leaveDialog.message).to.contain(
          'Import, which this installer enabled on "local", stays on'
        );
        expect(leaveDialog.message).to.contain("turn it off in Proxmox");
      });
    });

    it("stops asking to leave once the install completed", async () => {
      const calls: string[] = [];
      await enterProxmoxInstall(() =>
        mockTauriIpc((cmd) => {
          calls.push(cmd);
          if (cmd === "proxmox_create_vm") return { vm_id: 100, node: "pve" };
          if (cmd === "proxmox_get_vm_status")
            return { status: "running", ip_address: "192.0.2.50" };
          // Home Assistant is still starting
          if (cmd === "check_ha_ready") return new Promise(() => {});
          throw new Error(`Unexpected IPC command: ${cmd}`);
        })
      );
      await waitUntil(
        () => calls.includes("check_ha_ready") && !shellOf(el).hideFooter,
        "Cancel never came back once the VM existed"
      );
      const leaveDialog = el.shadowRoot!.querySelector(
        "info-dialog.leave-dialog"
      ) as InfoDialog;
      fireEvent(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      expect(leaveDialog.open).to.be.true;

      // Without waiting for the view to report it can no longer be left
      fireEvent(
        el.shadowRoot!.querySelector("proxmox-progress-view")!,
        "install-complete"
      );
      await el.updateComplete;
      expect(leaveDialog.open).to.be.false;
      expect(stopDialogOf(el).open).to.be.false;
      expect(wizardState.currentStep?.id).to.equal("success");
    });

    it("logs in again after the session expired, then waits for the VM it made", async () => {
      const calls: string[] = [];
      let expired = true;
      await enterProxmoxInstall(() => {
        wizardState.setSelection("proxmoxVmResult", {
          vm_id: 100,
          node: "pve",
        });
        mockTauriIpc((cmd) => {
          calls.push(cmd);
          if (cmd === "proxmox_get_vm_status") {
            if (expired) {
              return Promise.reject(
                ipcError(
                  "proxmox_session_expired",
                  "Proxmox session expired or invalid."
                )
              );
            }
            return { status: "running", ip_address: "192.0.2.50" };
          }
          if (cmd === "proxmox_certificate_fingerprint") return null;
          if (cmd === "proxmox_connect")
            return {
              server_url: "https://pve:8006",
              ticket: "renewed",
              csrf_token: "renewed",
            };
          if (cmd === "check_ha_ready") return new Promise(() => {});
          throw new Error(`Unexpected IPC command: ${cmd}`);
        });
      });

      // Not a dead end with only Cancel: Next logs in again
      await waitUntil(() => shellOf(el).nextLabel === "Reconnect");
      expect(shellOf(el).hideNext).to.be.false;
      expect(shellOf(el).hideFooter).to.be.false;
      const selections = wizardState.getState().selections;
      expect(selections.proxmoxSession).to.be.undefined;
      expect(selections.proxmoxPreviousServer?.server_url).to.equal(
        "https://pve:8006"
      );

      fireEvent(shellOf(el), "wizard-next");
      await waitUntil(
        () => !!shellOf(el).querySelector("proxmox-connect-view"),
        "Reconnect did not open the connect step"
      );
      expect((el as unknown as ErrorFlags)._installError).to.be.false;

      expired = false;
      Object.assign(shellOf(el).querySelector("proxmox-connect-view")!, {
        _password: "test",
      });
      fireEvent(shellOf(el), "wizard-next");

      // The VM exists: past its settings, straight back to waiting for it
      await waitUntil(
        () => calls.includes("check_ha_ready"),
        "The install did not resume"
      );
      expect(wizardState.currentStep?.id).to.equal("install");
      expect(calls).to.not.include("proxmox_create_vm");
      expect(calls).to.not.include("proxmox_check_vm_config");
    });

    it("hides Cancel once the VM is being created", async () => {
      let report!: (stage: string) => void;
      await enterProxmoxInstall(() =>
        mockTauriIpc((cmd, args) => {
          if (cmd === "proxmox_create_vm") {
            const { progressChannel } = args as {
              progressChannel: { onmessage: (progress: unknown) => void };
            };
            report = (stage) =>
              progressChannel.onmessage({
                stage,
                progress: 0,
                bytes_processed: 0,
                total_bytes: 0,
                message: "",
              });
            return new Promise(() => {});
          }
          throw new Error(`Unexpected IPC command: ${cmd}`);
        })
      );
      await waitUntil(() => !shellOf(el).hideFooter, "Cancel never showed");

      // The dialog was open when the install moved on: nothing left to ask
      fireEvent(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      report("creating_vm");
      await waitUntil(() => shellOf(el).hideFooter, "Cancel stayed");
      expect(stopDialogOf(el).open).to.be.false;
    });

    it("stops asking once the install failed", async () => {
      // The download keeps running
      await enterProxmoxInstall(() =>
        mockTauriIpc(() => new Promise(() => {}))
      );
      await waitUntil(() => !shellOf(el).hideFooter, "Cancel never showed");
      fireEvent(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      expect(stopDialogOf(el).open).to.be.true;

      // Without waiting for the view to report it can no longer stop
      fireEvent(
        el.shadowRoot!.querySelector("proxmox-progress-view")!,
        "install-error",
        { retryable: true, changeChoice: false }
      );
      await el.updateComplete;
      expect(stopDialogOf(el).open).to.be.false;
    });
  });

  // These flags reveal Cancel and "Try again" on the progress steps. Left
  // set, they would show over the next run's live write.
  describe("error state between runs", () => {
    it("is cleared when the wizard is cancelled", async () => {
      await enterSbcFlow(el);
      // Without a board there is nothing to download, so no write starts:
      // the progress view reports the flash error itself.
      selectTargets({ withBoard: false });
      await goToStep(el, "flash");
      await waitUntil(() =>
        showsError(shellOf(el).querySelector("progress-view")!)
      );

      fireEvent(shellOf(el), "wizard-cancel");
      await el.updateComplete;

      // Re-enter without going through path selection, so only the cancel
      // handler can have cleared the flag.
      wizardState.startFlow("sbc");
      selectTargets();
      await goToStep(el, "flash");
      fireEvent(
        el.shadowRoot!.querySelector("path-selection-view")!,
        "navigate",
        {
          view: "wizard",
        }
      );
      await el.updateComplete;

      // The live write offers Cancel only, no stale "Try again"
      expect(shellOf(el).hideFooter).to.be.false;
      expect(shellOf(el).hideNext).to.be.true;
    });

    it("is cleared for every flow when a new path is chosen", async () => {
      const flags = el as unknown as ErrorFlags;
      flags._installError = true;

      await enterSbcFlow(el);

      expect(flags._installError).to.be.false;
    });
  });

  describe("closing during an installation", () => {
    let calls: string[];

    const quitDialogOf = (el: AppShell) =>
      el.shadowRoot!.querySelector("info-dialog.quit-dialog") as InfoDialog;

    beforeEach(async () => {
      calls = [];
      mockTauriIpc(
        (cmd) => {
          calls.push(cmd);
          return undefined;
        },
        { mockEvents: true }
      );
      // A fresh shell, so it listens through the mocked Tauri events
      el = await fixture<AppShell>(html`<app-shell></app-shell>`);
      await settle();
    });

    async function blockClose() {
      await emit("close-blocked");
      await el.updateComplete;
      await quitDialogOf(el).updateComplete;
    }

    it("asks before quitting", async () => {
      expect(quitDialogOf(el).open).to.be.false;

      await blockClose();

      expect(quitDialogOf(el).open).to.be.true;
      expect(calls).not.to.include("quit_anyway");
    });

    it("quits when the user says so", async () => {
      await blockClose();

      (
        quitDialogOf(el).shadowRoot!.querySelector(
          "wa-button[variant='danger']"
        ) as HTMLElement
      ).click();
      await settle();

      expect(calls).to.include("quit_anyway");
      expect(quitDialogOf(el).open).to.be.false;
    });

    it("asks only about quitting when a stop question is open", async () => {
      // Into the flow on the browser mock, then hold the flash. Detach
      // first, so the shell stops listening while these events still exist.
      const parent = el.parentNode!;
      el.remove();
      await settle();
      restoreTauriIpc();
      parent.appendChild(el);
      await settle();
      await enterSbcFlow(el);
      selectTargets();
      mockTauriIpc(
        (cmd) => {
          calls.push(cmd);
          // The flash keeps running
          return cmd === "flash_image" ? new Promise(() => {}) : undefined;
        },
        { mockEvents: true }
      );
      // Reconnecting makes the shell listen through these events
      el.remove();
      parent.appendChild(el);
      await settle();
      await goToStep(el, "flash");
      fireEvent(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      const stopDialog = el.shadowRoot!.querySelector(
        "info-dialog.stop-dialog"
      ) as InfoDialog;
      expect(stopDialog.open).to.be.true;

      await blockClose();

      expect(stopDialog.open).to.be.false;
      expect(quitDialogOf(el).open).to.be.true;
    });

    for (const [flow, step, ended] of [
      ["sbc", "flash", "install-complete"],
      ["sbc", "flash", "install-error"],
      ["vm", "install", "install-complete"],
      ["vm", "install", "install-error"],
    ] as const) {
      it(`stops asking once the install ended (${ended})`, async () => {
        // The install keeps running until the test ends it
        mockTauriIpc(() => new Promise(() => {}), { mockEvents: true });
        // Reconnecting makes the shell listen through these events
        const parent = el.parentNode!;
        el.remove();
        parent.appendChild(el);
        await settle();
        wizardState.startFlow(flow);
        if (flow === "sbc") selectTargets();
        await goToStep(el, step);
        fireEvent(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
          view: "wizard",
        });
        await el.updateComplete;
        await blockClose();
        expect(quitDialogOf(el).open).to.be.true;

        if (ended === "install-complete") fireEvent(shellOf(el), ended);
        else
          fireEvent(shellOf(el), ended, {
            retryable: false,
            changeChoice: false,
          });
        await el.updateComplete;

        expect(quitDialogOf(el).open).to.be.false;
      });
    }

    it("logs, rather than throws, when it can't listen for close requests", async () => {
      const logged: unknown[] = [];
      el.remove();
      await settle();
      restoreTauriIpc();
      mockTauriIpc(
        (cmd, args) => {
          if (cmd === "plugin:event|listen") throw new Error("no events");
          if (cmd === "log_frontend_event") logged.push(args);
          return undefined;
        },
        { includeLogs: true }
      );

      el = await fixture<AppShell>(html`<app-shell></app-shell>`);
      await settle();

      expect(logged).to.have.length(1);
      expect(quitDialogOf(el).open).to.be.false;
    });

    it("keeps installing when the user changes their mind", async () => {
      await blockClose();

      (
        quitDialogOf(el).shadowRoot!.querySelector(
          "wa-button[appearance='outlined']"
        ) as HTMLElement
      ).click();
      await settle();

      expect(calls).not.to.include("quit_anyway");
      expect(quitDialogOf(el).open).to.be.false;
    });
  });
});
