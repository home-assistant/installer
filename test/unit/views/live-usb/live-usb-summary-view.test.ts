import { fixtureSync, html } from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/live-usb/live-usb-summary-view.js";
import type { LiveUsbSummaryView } from "../../../../src/views/live-usb/live-usb-summary-view.js";
import { expectReadsLeftToRight } from "../../helpers/bidi.js";

describe("live-usb-summary-view", () => {
  afterEach(() => {
    wizardState.reset();
  });

  it("reads the ISO path left to right even when its folders are Hebrew", async () => {
    wizardState.startFlow("minipc");
    wizardState.setSelection("liveMedia", "iso");
    wizardState.setSelection("liveIsoFolder", "/נתונים");
    wizardState.setSelection("liveIsoName", "haos.iso");
    const view = fixtureSync<LiveUsbSummaryView>(
      html`<live-usb-summary-view></live-usb-summary-view>`
    );
    await view.updateComplete;

    expectReadsLeftToRight(view.shadowRoot!.querySelector("dd bdi")!);
  });
});
