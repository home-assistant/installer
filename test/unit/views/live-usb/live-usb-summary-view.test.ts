import { expect, fixtureSync, html } from "@open-wc/testing";
import type { InlineNotice } from "../../../../src/components/inline-notice.js";
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

  it("warns that the stick is erased in a notice under the summary, not for an ISO", async () => {
    for (const [media, warns] of [
      ["usb", true],
      ["iso", false],
    ] as const) {
      wizardState.startFlow("minipc");
      wizardState.setSelection("liveMedia", media);
      wizardState.setSelection("driveName", "Stick");
      const view = fixtureSync<LiveUsbSummaryView>(
        html`<live-usb-summary-view></live-usb-summary-view>`
      );
      await view.updateComplete;

      const notice =
        view.shadowRoot!.querySelector<InlineNotice>("inline-notice");
      expect(!!notice, media).to.equal(warns);
      if (notice) {
        expect(notice.variant).to.equal("warning");
        expect(notice.textContent).to.contain("Everything on Stick");
        expect(notice.previousElementSibling!.className).to.equal("card");
      }
      view.remove();
      wizardState.reset();
    }
  });

  it("follows the selections while it shows", async () => {
    wizardState.startFlow("minipc");
    wizardState.setSelection("liveMedia", "iso");
    wizardState.setSelection("liveIsoFolder", "/home/me");
    wizardState.setSelection("liveIsoName", "haos.iso");
    const view = fixtureSync<LiveUsbSummaryView>(
      html`<live-usb-summary-view></live-usb-summary-view>`
    );
    await view.updateComplete;

    wizardState.setSelection("liveIsoOverwrite", true);
    await view.updateComplete;
    expect(
      view.shadowRoot!.querySelector("dd:last-of-type")!.textContent
    ).to.contain("Replaces the existing file.");
  });
});
