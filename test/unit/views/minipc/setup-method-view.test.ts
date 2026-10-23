import { expect, fixture, html } from "@open-wc/testing";
import "../../../../src/views/minipc/setup-method-view.js";
import type { MiniPCSetupMethodView } from "../../../../src/views/minipc/setup-method-view.js";
import type { OptionCard } from "../../../../src/components/option-card.js";
import {
  MINIPC_STEPS,
  wizardState,
} from "../../../../src/state/wizard-state.js";

async function renderMethod() {
  wizardState.startFlow("minipc");
  const el = await fixture<MiniPCSetupMethodView>(
    html`<minipc-setup-method-view></minipc-setup-method-view>`
  );
  const [connectDrive, usbBoot] =
    el.shadowRoot!.querySelectorAll<OptionCard>("option-card");
  return { el, connectDrive, usbBoot };
}

function stepIds() {
  return wizardState.getState().steps.map((step) => step.id);
}

describe("minipc-setup-method-view", () => {
  afterEach(() => {
    wizardState.reset();
  });

  it("offers connecting the drive or booting from USB", async () => {
    const { el, connectDrive, usbBoot } = await renderMethod();
    expect(el.shadowRoot!.querySelector("h2")!.textContent).to.contain(
      "How will you install?"
    );
    expect(connectDrive.heading).to.equal("I can connect the drive");
    expect(connectDrive.description).to.contain("SSD or NVMe");
    expect(usbBoot.heading).to.equal("I need to boot from USB");
    expect(usbBoot.description).to.contain("bootable USB drive");
  });

  it("continues to the architecture step when the drive can be connected", async () => {
    const { connectDrive } = await renderMethod();
    connectDrive.click();
    expect(wizardState.currentStep!.id).to.equal("architecture");
    expect(wizardState.getState().selections.installMethod).to.equal("direct");
  });

  it("continues to the media step when booting from USB", async () => {
    const { usbBoot } = await renderMethod();
    usbBoot.click();
    expect(wizardState.currentStep!.id).to.equal("media");
    expect(stepIds()).to.deep.equal(MINIPC_STEPS.usb.map((step) => step.id));
    expect(wizardState.getState().selections.installMethod).to.equal(
      "usb-boot"
    );
  });

  it("restores the direct steps after going back from USB boot", async () => {
    const { connectDrive, usbBoot } = await renderMethod();
    usbBoot.click();
    wizardState.previousStep();
    connectDrive.click();
    expect(wizardState.currentStep!.id).to.equal("architecture");
    expect(stepIds()).to.deep.equal(MINIPC_STEPS.direct.map((step) => step.id));
  });

  it("keeps the Wi-Fi step after going back and connecting the drive again", async () => {
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
