import { expect, fixture, html } from "@open-wc/testing";
import "../../../../src/views/minipc/media-view.js";
import type { MiniPCMediaView } from "../../../../src/views/minipc/media-view.js";
import type { OptionCard } from "../../../../src/components/option-card.js";

describe("minipc-media-view", () => {
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
});
