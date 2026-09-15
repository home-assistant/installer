import { expect, fixture, fixtureSync, html } from "@open-wc/testing";
import "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import "../../../src/components/device-card.js";
import type { DeviceCard } from "../../../src/components/device-card.js";

describe("device-card", () => {
  it("renders with name", async () => {
    const el = await fixture<DeviceCard>(html`
      <device-card name="Raspberry Pi 5"></device-card>
    `);

    const name = el.shadowRoot!.querySelector(".name");
    expect(name).to.exist;
    expect(name!.textContent).to.equal("Raspberry Pi 5");
  });

  it("renders with image when provided", async () => {
    const el = await fixture<DeviceCard>(html`
      <device-card
        name="Test Device"
        image="/assets/devices/test.svg"
      ></device-card>
    `);

    const img = el.shadowRoot!.querySelector(".image-container img");
    expect(img).to.exist;
    expect(img!.getAttribute("src")).to.equal("/assets/devices/test.svg");
  });

  it("renders placeholder when no image provided", async () => {
    const el = await fixture<DeviceCard>(html`
      <device-card name="Test Device"></device-card>
    `);

    const placeholder = el.shadowRoot!.querySelector(".image-placeholder");
    expect(placeholder).to.exist;
  });

  it("shows the selected indicator when checked", async () => {
    const el = await fixture<DeviceCard>(html`
      <device-card name="Test Device"></device-card>
    `);

    expect(el.shadowRoot!.querySelector(".selected-indicator")).to.be.null;

    el.checked = true;
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector(".selected-indicator")).to.exist;
  });

  it("has the correct structure", async () => {
    const el = await fixture<DeviceCard>(html`
      <device-card name="Test Device"></device-card>
    `);

    expect(el.shadowRoot!.querySelector(".card-wrapper")).to.exist;
    expect(el.shadowRoot!.querySelector(".card")).to.exist;
    expect(el.shadowRoot!.querySelector(".image-container")).to.exist;
    expect(el.shadowRoot!.querySelector(".name")).to.exist;
  });

  it("stores value property", async () => {
    const el = await fixture<DeviceCard>(html`
      <device-card value="rpi5" name="Raspberry Pi 5"></device-card>
    `);

    expect(el.value).to.equal("rpi5");
  });

  it("exposes radio semantics", async () => {
    const el = await fixture<DeviceCard>(html`
      <device-card value="rpi5" name="Raspberry Pi 5"></device-card>
    `);

    expect(el.getAttribute("role")).to.equal("radio");
    expect(el.getAttribute("aria-checked")).to.equal("false");

    el.checked = true;
    await el.updateComplete;

    expect(el.getAttribute("aria-checked")).to.equal("true");
  });

  // The keyboard behaviour itself belongs to <wa-radio-group>; what matters
  // here is that the card satisfies the contract the group drives it through.
  describe("inside a wa-radio-group", () => {
    // fixtureSync + updateComplete rather than fixture(): a non-Lit root makes
    // fixture() fall back to a requestAnimationFrame wait, which never fires
    // while the test page is backgrounded.
    const group = async (value = "") => {
      const root = fixtureSync<HTMLElement>(html`
        <wa-radio-group
          radio-tag="device-card"
          aria-label="Device"
          .value=${value}
        >
          ${[0, 1, 2].map(
            (i) => html`
              <device-card
                .value=${`d${i}`}
                .name=${`Device ${i}`}
              ></device-card>
            `
          )}
        </wa-radio-group>
      `);
      await (root as HTMLElement & { updateComplete: Promise<unknown> })
        .updateComplete;
      await Promise.all(
        Array.from(
          root.querySelectorAll<DeviceCard>("device-card"),
          (c) => c.updateComplete
        )
      );
      return root;
    };

    const cards = (root: HTMLElement) =>
      Array.from(root.querySelectorAll<DeviceCard>("device-card"));

    it("gives the group a single roving tab stop", async () => {
      const root = await group();
      const [first, second, third] = cards(root);

      expect(first!.tabIndex).to.equal(0);
      expect(second!.tabIndex).to.equal(-1);
      expect(third!.tabIndex).to.equal(-1);
    });

    it("checks the card matching the group's value", async () => {
      const root = await group("d2");
      const [first, , third] = cards(root);

      expect(third!.checked).to.be.true;
      expect(third!.getAttribute("aria-checked")).to.equal("true");
      expect(first!.checked).to.be.false;
      expect(third!.tabIndex).to.equal(0);
      expect(first!.tabIndex).to.equal(-1);
    });

    it("moves the selection with the arrow keys", async () => {
      const root = await group("d0");

      root.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
      );
      await (root as HTMLElement & { updateComplete: Promise<unknown> })
        .updateComplete;

      expect((root as HTMLElement & { value: string }).value).to.equal("d1");
      expect(cards(root)[1]!.checked).to.be.true;
    });

    it("selects a card on click", async () => {
      const root = await group();
      const [, second] = cards(root);

      second!.click();
      await (root as HTMLElement & { updateComplete: Promise<unknown> })
        .updateComplete;

      expect((root as HTMLElement & { value: string }).value).to.equal("d1");
      expect(second!.checked).to.be.true;
    });
  });
});
