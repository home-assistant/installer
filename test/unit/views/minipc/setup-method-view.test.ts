import { expect, fixture, html } from "@open-wc/testing";
import "../../../../src/views/minipc/setup-method-view.js";
import type { MiniPCSetupMethodView } from "../../../../src/views/minipc/setup-method-view.js";
import type { OptionCard } from "../../../../src/components/option-card.js";
import {
  MINIPC_STEPS,
  wizardState,
} from "../../../../src/state/wizard-state.js";

async function renderMethod({ shell = true } = {}) {
  wizardState.startFlow("minipc");
  const el = await fixture<MiniPCSetupMethodView>(
    html`<minipc-setup-method-view></minipc-setup-method-view>`
  );
  // Stands in for the app shell, which takes the pick as Next
  if (shell) el.addEventListener("wizard-next", () => wizardState.nextStep());
  const [usbStick, connectDrive, isoFile] =
    el.shadowRoot!.querySelectorAll<OptionCard>("option-card");
  return { el, usbStick, connectDrive, isoFile };
}

function stepIds() {
  return wizardState.getState().steps.map((step) => step.id);
}

describe("minipc-setup-method-view", () => {
  afterEach(() => {
    wizardState.reset();
  });

  it("offers the USB installer first, then writing the drive, then an ISO file", async () => {
    const { el, usbStick, connectDrive, isoFile } = await renderMethod();
    expect(el.shadowRoot!.querySelector("h2")!.textContent).to.contain(
      "How will you install?"
    );
    expect(usbStick.heading).to.equal("Create a USB installer");
    expect(usbStick.tag).to.equal("Recommended");
    expect(connectDrive.tag).to.equal("");
    expect(isoFile.tag).to.equal("");
    expect(connectDrive.heading).to.equal("Write the mini PC's drive here");
    expect(connectDrive.description).to.contain("SSD or NVMe");
    expect(isoFile.heading).to.equal("Save an ISO file");
  });

  it("draws the USB stick in the icon color, like the disc", async () => {
    const { usbStick, isoFile } = await renderMethod();
    const stick =
      usbStick.shadowRoot!.querySelector<HTMLElement>(".icon-file")!;
    expect(stick.style.getPropertyValue("--icon-file")).to.include(
      "usb-boot.svg"
    );
    const disc = isoFile.shadowRoot!.querySelector("ha-svg-icon")!;
    expect(getComputedStyle(stick).backgroundColor).to.equal(
      getComputedStyle(disc).color
    );
  });

  for (const [card, method, media, steps] of [
    ["usbStick", "usb-boot", "usb", MINIPC_STEPS.usb],
    ["connectDrive", "direct", undefined, MINIPC_STEPS.direct],
    ["isoFile", "usb-boot", "iso", MINIPC_STEPS.iso],
  ] as const) {
    it(`leaves moving on after ${card} to the app shell, once it is saved`, async () => {
      const rendered = await renderMethod({ shell: false });
      const sent: unknown[] = [];
      rendered.el.addEventListener("wizard-next", (event) => {
        const { selections } = wizardState.getState();
        sent.push({
          reachesShell: event.bubbles && event.composed,
          method: selections.installMethod,
          media: selections.liveMedia,
        });
      });

      rendered[card].click();

      expect(sent).to.deep.equal([{ reachesShell: true, method, media }]);
      expect(stepIds()).to.deep.equal(steps.map((step) => step.id));
      expect(wizardState.currentStep!.id).to.equal("method");
    });
  }

  it("goes on to the stick, with the stick's drive rules", async () => {
    const { usbStick } = await renderMethod();
    usbStick.click();
    expect(wizardState.currentStep!.id).to.equal("drive");
    const { selections } = wizardState.getState();
    expect(selections.device).to.be.undefined;
    expect(selections.deviceConfig?.minimum_storage_bytes).to.equal(
      2_000_000_000
    );
  });

  it("goes on to the save location for an ISO file", async () => {
    const { isoFile } = await renderMethod();
    isoFile.click();
    expect(wizardState.currentStep!.id).to.equal("location");
    expect(wizardState.getState().selections.deviceConfig).to.be.undefined;
  });

  it("goes on to the processor when writing the drive", async () => {
    const { connectDrive } = await renderMethod();
    connectDrive.click();
    expect(wizardState.currentStep!.id).to.equal("architecture");
  });

  it("keeps the Wi-Fi step after going back and writing the drive again", async () => {
    const { connectDrive } = await renderMethod();
    connectDrive.click();
    // The architecture step picked a board with Wi-Fi
    wizardState.setSelection("device", "generic-x86-64");
    wizardState.setSelection("deviceConfig", {
      board: "generic-x86-64",
      minimum_storage_bytes: 0,
      recommended_storage_bytes: 0,
    });
    expect(stepIds()).to.include("wifi");

    wizardState.previousStep();
    connectDrive.click();
    expect(wizardState.currentStep!.id).to.equal("architecture");
    expect(stepIds()).to.include("wifi");
  });
});
