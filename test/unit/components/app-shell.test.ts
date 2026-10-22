import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import { emit } from "@tauri-apps/api/event";
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
import { flush, holdDeviceScan } from "../helpers/hold-device-scan.js";
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
  nextLabel: string;
  nextDisabled: boolean;
  nextBusy: boolean;
  hideFooter: boolean;
  hideNext: boolean;
  hideCancel: boolean;
}

interface ErrorFlags {
  _flashError: boolean;
  _vmInstallError: boolean;
}

function fire(target: Element, type: string, detail?: unknown) {
  target.dispatchEvent(
    new CustomEvent(type, { detail, bubbles: true, composed: true })
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
  fire(dialogOf(el).shadowRoot!.querySelector("wa-dialog")!, "wa-after-hide");
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
  fire(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
    view: "path-selection",
  });
  await el.updateComplete;
  fire(el.shadowRoot!.querySelector("path-selection-view")!, "select-path", {
    path: "proxmox",
  });
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
  fire(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
    view: "path-selection",
  });
  await el.updateComplete;
  fire(el.shadowRoot!.querySelector("path-selection-view")!, "select-path", {
    path: "sbc",
  });
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
    fire(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
      view: "path-selection",
    });
    await el.updateComplete;
    fire(el.shadowRoot!.querySelector("path-selection-view")!, "select-path", {
      path: "proxmox",
    });
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
          .shadowRoot!.querySelector("[role=alert]")
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

    fire(shellOf(el), "wizard-next");
    await waitUntil(() => shellOf(el).nextLabel === "Checking settings...");
    // Busy rather than disabled, so it keeps the focus
    expect(shellOf(el).nextBusy).to.be.true;
    expect(shellOf(el).nextDisabled).to.be.false;
    // Nothing else sends the step on meanwhile either
    fire(shellOf(el), "wizard-next");
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
        .shadowRoot!.querySelector("[role=alert]")!.textContent
    ).to.contain("VM ID 100 can't be used.");

    check = deferred<unknown>();
    fire(shellOf(el), "wizard-next");
    check.resolve(null);
    await waitUntil(() => wizardState.currentStep?.id === "confirm");
  });

  it("leaves a settings check behind when the user goes back", async () => {
    const check = deferred<unknown>();
    await enterProxmoxConfigure(el, () => check.promise);
    fire(shellOf(el), "wizard-next");
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
      wizardState.setSelection("device", "saved-device");
      wizardState.setSelection("deviceCatalogReady", false);
      await el.updateComplete;
      expect(shellOf(el).nextDisabled).to.equal(true);
      wizardState.setSelection("deviceCatalogReady", true);
      await el.updateComplete;
      expect(shellOf(el).nextDisabled).to.equal(false);
      wizardState.setSelection("device", undefined);
      await el.updateComplete;
      expect(shellOf(el).nextDisabled).to.equal(true);
    });
  }

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
      fire(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
        view: "path-selection",
      });
      await el.updateComplete;
      fire(
        el.shadowRoot!.querySelector("path-selection-view")!,
        "select-path",
        { path: "proxmox" }
      );
      await waitUntil(
        () =>
          !!el
            .shadowRoot!.querySelector("connection-check-view")
            ?.shadowRoot?.querySelector('[role="alert"]')
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

    for (const path of ["sbc", "minipc", "ha-hardware", "vm", "proxmox"]) {
      it(`checks connectivity before starting ${path} and allows Back`, async () => {
        const pending = deferred<void>();
        const calls: string[] = [];
        mockTauriIpc((command) => {
          // The path selection asks on a Mac; that's not part of the gate
          if (command === "utm_supported") return true;
          calls.push(command);
          return pending.promise;
        });
        fire(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
          view: "path-selection",
        });
        await el.updateComplete;
        fire(
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

  it("returns to path selection when Back leaves the first step", async () => {
    await enterSbcFlow(el);
    wizardState.setSelection("device", "rpi5");

    fire(shellOf(el), "wizard-exit");
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector("path-selection-view")).to.exist;
    expect(shellOf(el)).to.equal(null);
    expect(wizardState.getState().currentFlow).to.equal(null);
    expect(wizardState.getState().selections).to.deep.equal({});
  });

  it("offers only Done once the installation succeeded", async () => {
    await enterSbcFlow(el);
    expect(shellOf(el).hideCancel).to.be.false;

    await goToStep(el, "success");
    expect(shellOf(el).hideCancel).to.be.true;
    expect(shellOf(el).nextLabel).to.equal("Done");
  });

  it("does not hold up a new flow with a Proxmox connect left behind", async () => {
    const fingerprint = deferred<string | null>();
    mockTauriIpc((cmd) => {
      if (cmd === "check_connection") return undefined;
      if (cmd === "proxmox_certificate_fingerprint") return fingerprint.promise;
      throw new Error(cmd);
    });
    const enterProxmox = async () => {
      fire(
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
    fire(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
      view: "path-selection",
    });
    await el.updateComplete;
    await enterProxmox();
    Object.assign(shellOf(el).querySelector("proxmox-connect-view")!, {
      _serverUrl: "https://pve:8006",
      _password: "test",
    });

    fire(shellOf(el), "wizard-next");
    await waitUntil(() => shellOf(el).nextBusy);
    expect(shellOf(el).nextLabel).to.equal("Connecting...");
    expect(shellOf(el).nextDisabled).to.be.false;
    fire(shellOf(el), "wizard-exit");
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

    fire(shellOf(el), "wizard-next");
    await waitForDialogOpen(el);
    fire(dialogOf(el), "dialog-confirm");
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

  it("leaves Next as it is while the reinstall question is open", async () => {
    await enterSbcFlow(el);
    wizardState.startFlow("ha-hardware");
    wizardState.setSelection("device", "ha-green");
    await el.updateComplete;
    await waitUntil(
      () => wizardState.getState().selections.deviceCatalogReady === true
    );
    await el.updateComplete;
    const question = () =>
      shellOf(el)
        .querySelector("ha-hardware-device-selection-view")!
        .shadowRoot!.querySelector("info-dialog") as InfoDialog;

    fire(shellOf(el), "wizard-next");
    await waitUntil(() => question().open);
    await el.updateComplete;
    // Not disabled, so the question returns the focus to it
    expect(shellOf(el).nextDisabled).to.be.false;
    expect(shellOf(el).nextBusy).to.be.false;
    expect(shellOf(el).nextLabel).to.equal("Next");

    fire(question(), "dialog-secondary");
    await settle();
    expect(wizardState.currentStep?.id).to.equal("device");
  });

  describe("selected drive check before erasing", () => {
    beforeEach(async () => {
      await enterSbcFlow(el);
      selectTargets();
      await goToStep(el, "confirm");
    });

    it("writes to the drive when it is still connected", async () => {
      fire(shellOf(el), "wizard-next");
      await waitForDialogOpen(el);

      fire(dialogOf(el), "dialog-confirm");
      expect(wizardState.currentStep!.id).to.equal("confirm");
      await finishDialogHide(el);

      await waitUntil(
        () => wizardState.currentStep?.id === "flash",
        "never reached the write step"
      );
      fire(
        dialogOf(el).shadowRoot!.querySelector("wa-dialog")!,
        "wa-after-hide"
      );
      await flush();
      expect(wizardState.currentStep!.id).to.equal("flash");
    });

    it("does not advance if the selected configuration changes while the dialog closes", async () => {
      fire(shellOf(el), "wizard-next");
      await waitForDialogOpen(el);
      fire(dialogOf(el), "dialog-confirm");
      wizardState.setSelection("device", "different-device");
      await finishDialogHide(el);
      expect(wizardState.currentStep!.id).to.equal("confirm");
    });

    it("does not advance after cancelling the dialog", async () => {
      fire(shellOf(el), "wizard-next");
      await waitForDialogOpen(el);
      fire(dialogOf(el), "dialog-cancel");
      await finishDialogHide(el);
      expect(wizardState.currentStep!.id).to.equal("confirm");
    });

    it("returns to drive selection when the path names a different disk", async () => {
      wizardState.setSelection("driveModel", "A Completely Different Stick");

      fire(shellOf(el), "wizard-next");

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
      fire(shellOf(el), "wizard-next");
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
        fire(shellOf(el), "wizard-next");
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
        fire(shellOf(el), "wizard-next");
        await waitUntil(() => shellOf(el).nextLabel === "Checking drive...");
        // Busy rather than disabled: the erase dialog then returns the focus
        // to it when cancelled
        expect(shellOf(el).nextBusy).to.be.true;
        expect(shellOf(el).nextDisabled).to.be.false;

        fire(shellOf(el), "wizard-next");
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
      fire(shellOf(el), "wizard-next");
      await waitForDialogOpen(el);

      wizardState.setSelection("driveModel", "Swapped While You Read This");
      fire(dialogOf(el), "dialog-confirm");
      await finishDialogHide(el);

      await waitUntil(
        () => wizardState.currentStep?.id === "drive",
        "the write was not held back"
      );
    });

    it("rechecks the board minimum before erasing", async () => {
      fire(shellOf(el), "wizard-next");
      await waitUntil(() => dialogOf(el).hasAttribute("open"));

      wizardState.setSelection("deviceConfig", {
        ...MOCK_MANIFEST.devices[0].haos,
        minimum_storage_bytes: CONNECTED.size * 2,
        recommended_storage_bytes: CONNECTED.size * 2,
      });
      fire(dialogOf(el), "dialog-confirm");
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
      fire(shellOf(el), "flash-complete");
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

      fire(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      expect(stopDialogOf(el).open).to.be.true;

      fire(stopDialogOf(el), "dialog-secondary");
      await el.updateComplete;
      expect(stopDialogOf(el).open).to.be.false;
      expect(wizardState.currentStep?.id).to.equal("flash");
      expect(shellOf(el).hideFooter).to.be.false;
    });

    it("stops the flash and offers to install again", async () => {
      fire(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      fire(stopDialogOf(el), "dialog-primary");
      await el.updateComplete;
      // No buttons while the flash winds down
      expect(shellOf(el).hideFooter).to.be.true;

      await waitUntil(() => shellOf(el).nextLabel === "Try again");
      expect(shellOf(el).hideFooter).to.be.false;
      expect(wizardState.currentStep?.id).to.equal("flash");
      expect(el.shadowRoot!.querySelector("progress-view")!.hasError).to.be
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

    fire(shellOf(el), "wizard-cancel");
    await el.updateComplete;
    fire(
      el.shadowRoot!.querySelector("info-dialog.stop-dialog")!,
      "dialog-primary"
    );
    await settle();
    await el.updateComplete;

    expect(shellOf(el).hideFooter).to.be.false;
    expect(wizardState.currentStep?.id).to.equal("flash");
  });

  describe("cancelling a running VM install", () => {
    const stopDialogOf = (el: AppShell) =>
      el.shadowRoot!.querySelector("info-dialog.stop-dialog") as InfoDialog;

    /** `mockBackend` runs once the flow is entered, before the install starts */
    async function enterProxmoxInstall(mockBackend?: () => void) {
      fire(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
        view: "path-selection",
      });
      await el.updateComplete;
      fire(
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

      fire(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      expect(stopDialogOf(el).open).to.be.true;
      expect(stopDialogOf(el).message).to.contain("nothing is left behind");

      fire(stopDialogOf(el), "dialog-primary");
      await waitUntil(() => shellOf(el).nextLabel === "Try again");
      expect(shellOf(el).hideFooter).to.be.false;
      expect(wizardState.currentStep?.id).to.equal("install");
      expect(el.shadowRoot!.querySelector("proxmox-progress-view")!.hasError).to
        .be.true;
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

      fire(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      expect(leaveDialog.open).to.be.true;
      expect(stopDialogOf(el).open).to.be.false;
      expect(leaveDialog.heading).to.equal("Leave the installation?");
      expect(leaveDialog.message).to.contain("http://192.0.2.50");

      fire(leaveDialog, "dialog-secondary");
      await el.updateComplete;
      expect(leaveDialog.open).to.be.false;
      expect(wizardState.currentStep?.id).to.equal("install");

      fire(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      fire(leaveDialog, "dialog-primary");
      await el.updateComplete;
      expect(el.shadowRoot!.querySelector("welcome-view")).to.exist;
      expect(wizardState.getState().selections.proxmoxVmResult).to.be.undefined;
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

      fire(shellOf(el), "wizard-next");
      await waitUntil(
        () => !!shellOf(el).querySelector("proxmox-connect-view"),
        "Reconnect did not open the connect step"
      );
      expect((el as unknown as ErrorFlags)._vmInstallError).to.be.false;

      expired = false;
      Object.assign(shellOf(el).querySelector("proxmox-connect-view")!, {
        _password: "test",
      });
      fire(shellOf(el), "wizard-next");

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
      fire(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      report("creating_vm");
      await waitUntil(() => shellOf(el).hideFooter, "Cancel stayed");
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
      await waitUntil(() => shellOf(el).nextLabel === "Choose another drive");

      fire(shellOf(el), "wizard-cancel");
      await el.updateComplete;

      // Re-enter without going through path selection, so only the cancel
      // handler can have cleared the flag.
      wizardState.startFlow("sbc");
      selectTargets();
      await goToStep(el, "flash");
      fire(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
        view: "wizard",
      });
      await el.updateComplete;

      // The live write offers Cancel only, no stale "Try again"
      expect(shellOf(el).hideFooter).to.be.false;
      expect(shellOf(el).hideNext).to.be.true;
    });

    it("is cleared for every flow when a new path is chosen", async () => {
      const flags = el as unknown as ErrorFlags;
      flags._flashError = true;
      flags._vmInstallError = true;

      await enterSbcFlow(el);

      expect(flags._flashError).to.be.false;
      expect(flags._vmInstallError).to.be.false;
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
      fire(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      const stopDialog = el.shadowRoot!.querySelector(
        "info-dialog.stop-dialog"
      ) as InfoDialog;
      expect(stopDialog.open).to.be.true;

      await blockClose();

      expect(stopDialog.open).to.be.false;
      expect(quitDialogOf(el).open).to.be.true;
    });

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
