import { expect, fixture, html } from "@open-wc/testing";
import "../../../../src/views/minipc/media-view.js";
import type { MiniPCMediaView } from "../../../../src/views/minipc/media-view.js";
import type { OptionCard } from "../../../../src/components/option-card.js";
import {
  MINIPC_STEPS,
  wizardState,
} from "../../../../src/state/wizard-state.js";

describe("minipc-media-view", () => {
  afterEach(() => {
    wizardState.reset();
  });

  it("draws the USB stick in the icon color, like the disc next to it", async () => {
    const el = await fixture<MiniPCMediaView>(
      html`<minipc-media-view></minipc-media-view>`
    );
    const [usb, iso] =
      el.shadowRoot!.querySelectorAll<OptionCard>("option-card");
    expect(usb!.heading).to.equal("Write to a USB stick");
    expect(iso!.heading).to.equal("Save an ISO file");

    const stick = usb!.shadowRoot!.querySelector<HTMLElement>(".icon-file")!;
    expect(stick.style.getPropertyValue("--icon-file")).to.include(
      "usb-boot.svg"
    );
    const disc = iso!.shadowRoot!.querySelector("ha-svg-icon")!;
    expect(getComputedStyle(stick).backgroundColor).to.equal(
      getComputedStyle(disc).color
    );
  });

  for (const [index, media] of [
    [0, "usb"],
    [1, "iso"],
  ] as const) {
    it(`leaves moving on after picking ${media} to the app shell, once it is saved`, async () => {
      wizardState.startFlow("minipc");
      wizardState.setSelection("installMethod", "usb-boot");
      wizardState.setSteps(MINIPC_STEPS.usb);
      wizardState.nextStep();
      const el = await fixture<MiniPCMediaView>(
        html`<minipc-media-view></minipc-media-view>`
      );
      const sent: unknown[] = [];
      el.addEventListener("wizard-next", (event) =>
        sent.push({
          reachesShell: event.bubbles && event.composed,
          media: wizardState.getState().selections.liveMedia,
        })
      );

      el.shadowRoot!.querySelectorAll<OptionCard>("option-card")[
        index
      ]!.click();

      expect(sent).to.deep.equal([{ reachesShell: true, media }]);
      expect(wizardState.getState().steps.map(({ id }) => id)).to.deep.equal(
        MINIPC_STEPS[media].map(({ id }) => id)
      );
      expect(wizardState.currentStep!.id).to.equal("media");
    });
  }
});
