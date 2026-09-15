import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import "../../../src/components/app-shell.js";
import type { AppShell } from "../../../src/components/app-shell.js";
import type { ConfirmDialog } from "../../../src/components/confirm-dialog.js";
import { MOCK_BLOCK_DEVICES } from "../../../src/api/mock-data.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import { storeDriveSelection } from "../../../src/utils/drive-selection.js";

// Browser-only mode (no Tauri) serves MOCK_BLOCK_DEVICES, so this is the drive
// that is "connected" for the duration of these tests.
const CONNECTED = MOCK_BLOCK_DEVICES[0];

interface WizardShell extends HTMLElement {
  nextLabel: string;
  nextDisabled: boolean;
  hideFooter: boolean;
}

interface ErrorFlags {
  _flashError: boolean;
  _utmInstallError: boolean;
  _proxmoxInstallError: boolean;
}

/** The private per-run error flags, which are the subject of F10. */
const errorFlags = (el: AppShell) => el as unknown as ErrorFlags;

function fire(target: Element, type: string, detail?: unknown) {
  target.dispatchEvent(
    new CustomEvent(type, { detail, bubbles: true, composed: true })
  );
}

const view = (el: AppShell, selector: string) =>
  el.shadowRoot!.querySelector(selector);

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

  it("starts on the welcome view", () => {
    expect(view(el, "welcome-view")).to.exist;
  });

  describe("erase confirmation", () => {
    beforeEach(async () => {
      await enterSbcFlow(el);
      selectTargets();
      await goToStep(el, "confirm");
    });

    it("opens the dialog when the selected drive is still connected", async () => {
      fire(shellOf(el), "wizard-next");

      await waitUntil(
        () => dialogOf(el).hasAttribute("open"),
        "erase dialog never opened"
      );
      expect(wizardState.currentStep!.id).to.equal("confirm");
    });

    // F11: the path is the one value sent to the backend, and the only thing
    // that tells two identical cards apart at the point of no return.
    it("names the exact device it is about to erase", async () => {
      fire(shellOf(el), "wizard-next");
      await waitUntil(() => dialogOf(el).hasAttribute("open"));

      const dialog = dialogOf(el);
      expect(dialog.drivePath).to.equal(CONNECTED.id);
      expect(dialog.driveName).to.equal(CONNECTED.name);
      expect(dialog.driveSize).to.equal(CONNECTED.size);
      expect(dialog.driveModel).to.contain(CONNECTED.model!);
    });

    it("writes to the confirmed drive when the user accepts", async () => {
      fire(shellOf(el), "wizard-next");
      await waitUntil(() => dialogOf(el).hasAttribute("open"));

      fire(dialogOf(el), "dialog-confirm");

      await waitUntil(
        () => wizardState.currentStep?.id === "flash",
        "never reached the write step"
      );
      expect(wizardState.getState().selections.drive).to.equal(CONNECTED.id);
    });

    it("stays put when the user dismisses the dialog", async () => {
      fire(shellOf(el), "wizard-next");
      await waitUntil(() => dialogOf(el).hasAttribute("open"));

      fire(dialogOf(el), "dialog-cancel");
      await el.updateComplete;

      expect(dialogOf(el).hasAttribute("open")).to.be.false;
      expect(wizardState.currentStep!.id).to.equal("confirm");
    });
  });

  // F8: the device id doubles as the path written to, and the OS reassigns
  // those. A selection made minutes ago can name a disk the user never chose.
  describe("stale drive selections", () => {
    beforeEach(async () => {
      await enterSbcFlow(el);
      selectTargets();
    });

    it("refuses to open the dialog when the path names a different disk", async () => {
      wizardState.setSelection("driveModel", "A Completely Different Stick");
      await goToStep(el, "confirm");

      fire(shellOf(el), "wizard-next");

      await waitUntil(
        () => wizardState.currentStep?.id === "drive",
        "never returned to drive selection"
      );
      expect(dialogOf(el).hasAttribute("open")).to.be.false;
    });

    it("sends the user back to pick again, with the stale choice dropped", async () => {
      wizardState.setSelection("driveSize", 1);
      await goToStep(el, "confirm");

      fire(shellOf(el), "wizard-next");

      await waitUntil(
        () => wizardState.getState().selections.drive === undefined,
        "stale selection was never cleared"
      );
      expect(wizardState.currentStep!.id).to.equal("drive");
    });

    it("refuses when nothing is selected at all", async () => {
      wizardState.setSelection("drive", undefined);
      await goToStep(el, "confirm");

      fire(shellOf(el), "wizard-next");

      await waitUntil(() => wizardState.currentStep?.id === "drive");
      expect(dialogOf(el).hasAttribute("open")).to.be.false;
    });

    // The dialog can sit open for any length of time, and confirming starts
    // the write immediately — so the device is checked once more on confirm.
    it("re-checks between opening the dialog and the write", async () => {
      await goToStep(el, "confirm");
      fire(shellOf(el), "wizard-next");
      await waitUntil(() => dialogOf(el).hasAttribute("open"));

      // The stick is swapped while the user reads the dialog.
      wizardState.setSelection("driveModel", "Swapped While You Read This");

      fire(dialogOf(el), "dialog-confirm");

      await waitUntil(
        () => wizardState.currentStep?.id === "drive",
        "the write was not held back"
      );
      expect(wizardState.currentStep!.id).to.not.equal("flash");
    });
  });

  // F10: these flags are what reveal Cancel and "Try again" on the otherwise
  // chrome-less progress steps. Left set, they put those controls on screen
  // over the *next* run's live write — and Cancel cannot stop the backend.
  describe("error state between runs", () => {
    /** Land on the flash step of a run that has failed. */
    async function failedRun() {
      await enterSbcFlow(el);
      // Without a board there is nothing to download, so no write starts.
      selectTargets({ withBoard: false });
      await goToStep(el, "flash");

      // How a flash that fails part-way through reports itself.
      fire(shellOf(el).querySelector("progress-view")!, "flash-error");
      await waitUntil(
        () => shellOf(el).nextLabel === "Try again",
        "the failed run never offered a retry"
      );
    }

    /** Land on the flash step of a run that is actively writing. */
    async function liveRun() {
      wizardState.startFlow("sbc");
      selectTargets();
      wizardState.goToStep(
        wizardState.getState().steps.findIndex((step) => step.id === "flash")
      );
      await el.updateComplete;
    }

    it("shows Cancel and Try again after a failed flash", async () => {
      await failedRun();

      expect(shellOf(el).hideFooter).to.be.false;
      expect(shellOf(el).nextLabel).to.equal("Try again");
    });

    it("hides the footer during a live write", async () => {
      await enterSbcFlow(el);
      selectTargets();
      await goToStep(el, "flash");

      expect(shellOf(el).hideFooter).to.be.true;
    });

    it("clears the error when the wizard is cancelled", async () => {
      await failedRun();

      fire(shellOf(el), "wizard-cancel");
      await el.updateComplete;
      expect(view(el, "welcome-view")).to.exist;

      // Re-enter without going through path selection, so only the cancel
      // handler can have cleared the flag.
      await liveRun();
      fire(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
        view: "wizard",
      });
      await el.updateComplete;

      expect(shellOf(el).hideFooter).to.be.true;
      expect(shellOf(el).nextLabel).to.equal("Next");
    });

    // Each flow has its own flag and the UTM and Proxmox ones are set on
    // steps this suite never reaches, so check all three at the source. From
    // inside the wizard, Cancel is the only way out that is not a retry.
    it("clears every error flag on cancel", async () => {
      await enterSbcFlow(el);
      const flags = errorFlags(el);
      flags._flashError = true;
      flags._utmInstallError = true;
      flags._proxmoxInstallError = true;

      fire(shellOf(el), "wizard-cancel");
      await el.updateComplete;

      expect(flags._flashError).to.be.false;
      expect(flags._utmInstallError).to.be.false;
      expect(flags._proxmoxInstallError).to.be.false;
    });

    it("clears every error flag when a new path is chosen", async () => {
      const flags = errorFlags(el);
      flags._flashError = true;
      flags._utmInstallError = true;
      flags._proxmoxInstallError = true;

      fire(el.shadowRoot!.querySelector("welcome-view")!, "navigate", {
        view: "path-selection",
      });
      await el.updateComplete;
      fire(
        el.shadowRoot!.querySelector("path-selection-view")!,
        "select-path",
        { path: "sbc" }
      );
      await el.updateComplete;

      expect(flags._flashError).to.be.false;
      expect(flags._utmInstallError).to.be.false;
      expect(flags._proxmoxInstallError).to.be.false;
    });
  });
});
