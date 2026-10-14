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
  hideFooter: boolean;
  hideNext: boolean;
}

interface ErrorFlags {
  _flashError: boolean;
  _utmInstallError: boolean;
  _proxmoxInstallError: boolean;
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

  afterEach(() => {
    restoreTauriIpc();
    // A mock flash keeps running after teardown. The detached tree still has
    // app-shell as an ancestor, so drop the wizard subtree: otherwise a late
    // "complete" would advance the shared wizard state under a later test.
    el.shadowRoot?.querySelector("wizard-shell")?.remove();
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

  for (const [flow, step] of [
    ["sbc", "device"],
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
    it("keeps Home Assistant hardware guidance available without network access", async () => {
      let calls = 0;
      mockTauriIpc(() => {
        calls++;
        return Promise.reject("offline");
      });
      fire(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
        view: "path-selection",
      });
      await el.updateComplete;
      fire(
        el.shadowRoot!.querySelector("path-selection-view")!,
        "select-path",
        { path: "ha-hardware" }
      );
      await waitUntil(() => !!shellOf(el));
      expect(wizardState.getState().currentFlow).to.equal("ha-hardware");
      expect(calls).to.equal(0);
    });

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

    for (const path of ["sbc", "minipc", "vm", "proxmox"]) {
      it(`checks connectivity before starting ${path} and allows Back`, async () => {
        const pending = deferred<void>();
        const calls: string[] = [];
        mockTauriIpc((command) => {
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

    it("ignores a check that finishes after the user went back", async () => {
      const scan = holdDeviceScan();
      try {
        fire(shellOf(el), "wizard-next");
        await waitUntil(() => shellOf(el).nextLabel === "Checking drive...");

        wizardState.previousStep();
        scan.resolve(MOCK_BLOCK_DEVICES);
        await flush();

        expect(dialogOf(el).hasAttribute("open")).to.be.false;
        expect(wizardState.currentStep!.id).to.equal("drive");
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

  // Browser-only mode runs the simulated flash, which honors a stop too
  describe("cancelling a running flash", () => {
    const stopDialogOf = (el: AppShell) =>
      el.shadowRoot!.querySelector("info-dialog") as InfoDialog;

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
    fire(el.shadowRoot!.querySelector("info-dialog")!, "dialog-primary");
    await settle();
    await el.updateComplete;

    expect(shellOf(el).hideFooter).to.be.false;
    expect(wizardState.currentStep?.id).to.equal("flash");
  });

  describe("cancelling a running VM install", () => {
    const stopDialogOf = (el: AppShell) =>
      el.shadowRoot!.querySelector("info-dialog") as InfoDialog;

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
      flags._utmInstallError = true;
      flags._proxmoxInstallError = true;

      await enterSbcFlow(el);

      expect(flags._flashError).to.be.false;
      expect(flags._utmInstallError).to.be.false;
      expect(flags._proxmoxInstallError).to.be.false;
    });
  });

  describe("closing during an installation", () => {
    let calls: string[];

    const quitDialogOf = (el: AppShell) =>
      el.shadowRoot!.querySelector("info-dialog") as InfoDialog;

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

    it("logs, rather than throws, when it can't listen for close requests", async () => {
      const logged: unknown[] = [];
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
