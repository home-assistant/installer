import { expect } from "@open-wc/testing";
import { html, render } from "lit";
import "../../../src/components/option-card.js";
import "../../../src/components/device-card.js";
import "../../../src/components/drive-card.js";
import type { OptionCard } from "../../../src/components/option-card.js";
import type { DeviceCard } from "../../../src/components/device-card.js";
import type { DriveCard } from "../../../src/components/drive-card.js";

// The option, device and drive cards share one frame, so they can't drift
// apart.
// How they answer the pointer is in test/e2e/card-pointer.spec.ts: a test
// page in the background doesn't get mouse moves.

type Card = OptionCard | DeviceCard | DriveCard;

function pick(element: Element, properties: (keyof CSSStyleDeclaration)[]) {
  const style = getComputedStyle(element);
  return Object.fromEntries(properties.map((name) => [name, style[name]]));
}

describe("card styles", () => {
  let container: HTMLElement;
  let cards: Card[];

  beforeEach(async () => {
    // A plain container: fixture() would wait for a frame, which a background
    // test page never paints
    container = document.body.appendChild(document.createElement("div"));
    render(
      html`<option-card heading="Option"></option-card>
        <device-card name="Device" value="device"></device-card>
        <drive-card name="Drive" value="/dev/sda"></drive-card>`,
      container
    );
    cards = [...container.children] as Card[];
    await Promise.all(cards.map((card) => card.updateComplete));
  });

  afterEach(() => {
    container.remove();
  });

  it("frames the option, device and drive cards alike", () => {
    const [option, ...others] = cards.map((card) =>
      pick(card.shadowRoot!.querySelector(".card")!, [
        "backgroundColor",
        "borderTopWidth",
        "borderTopStyle",
        "borderTopColor",
        "borderTopLeftRadius",
        "boxSizing",
        "cursor",
        "transition",
      ])
    );
    expect(option!.cursor).to.equal("pointer");
    for (const other of others) {
      expect(other).to.deep.equal(option);
    }
  });
});
