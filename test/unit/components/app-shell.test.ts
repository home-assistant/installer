import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import "../../../src/components/app-shell.js";
import type { AppShell } from "../../../src/components/app-shell.js";
import type { ConfirmDialog } from "../../../src/components/confirm-dialog.js";
import { MOCK_BLOCK_DEVICES } from "../../../src/api/mock-data.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import { storeDriveSelection } from "../../../src/utils/drive-selection.js";
import { flush, holdDeviceScan } from "../helpers/hold-device-scan.js";

// Browser-only mode (no Tauri) serves MOCK_BLOCK_DEVICES, so this is the drive
// that is "connected" for the duration of these tests.
const CONNECTED = MOCK_BLOCK_DEVICES[0];

interface WizardShell extends HTMLElement {
  nextLabel: string;
  hideFooter: boolean;
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

/** Pick a device and a drive, as the two selection steps would. */
function selectTargets({ withBoard = true } = {}) {
  wizardState.setSelection("device", "rpi5");
  wizardState.setSelection("deviceName", "Raspberry Pi 5");
  if (withBoard) {
    wizardState.setSelection("deviceConfig", { board: "rpi5-64" });
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
  await el.updateComplete;
}

describe("app-shell", () => {
  let el: AppShell;

  beforeEach(async () => {
    wizardState.reset();
    el = await fixture<AppShell>(html`<app-shell></app-shell>`);
  });

  afterEach(() => {
    // A mock flash keeps running after teardown. The detached tree still has
    // app-shell as an ancestor, so drop the wizard subtree: otherwise a late
    // "complete" would advance the shared wizard state under a later test.
    el.shadowRoot?.querySelector("wizard-shell")?.remove();
    wizardState.reset();
  });

  describe("selected drive check before erasing", () => {
    beforeEach(async () => {
      await enterSbcFlow(el);
      selectTargets();
      await goToStep(el, "confirm");
    });

    it("writes to the drive when it is still connected", async () => {
      fire(shellOf(el), "wizard-next");
      await waitUntil(() => dialogOf(el).hasAttribute("open"));

      fire(dialogOf(el), "dialog-confirm");

      await waitUntil(
        () => wizardState.currentStep?.id === "flash",
        "never reached the write step"
      );
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
      await waitUntil(() => dialogOf(el).hasAttribute("open"));

      wizardState.setSelection("driveModel", "Swapped While You Read This");
      fire(dialogOf(el), "dialog-confirm");

      await waitUntil(
        () => wizardState.currentStep?.id === "drive",
        "the write was not held back"
      );
    });
  });

  // These flags reveal Cancel and "Try again" on the progress steps. Left
  // set, they would show over the next run's live write.
  describe("error state between runs", () => {
    it("is cleared when the wizard is cancelled", async () => {
      await enterSbcFlow(el);
      // Without a board there is nothing to download, so no write starts.
      selectTargets({ withBoard: false });
      await goToStep(el, "flash");
      fire(shellOf(el).querySelector("progress-view")!, "flash-error");
      await waitUntil(() => shellOf(el).nextLabel === "Try again");

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

      expect(shellOf(el).hideFooter).to.be.true;
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
});
