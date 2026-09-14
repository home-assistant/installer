import { expect, fixture, fixtureSync, html } from "@open-wc/testing";
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

  it("shows selected state when selected", async () => {
    const el = await fixture<DeviceCard>(html`
      <device-card name="Test Device" selected></device-card>
    `);

    const card = el.shadowRoot!.querySelector(".card");
    expect(card!.classList.contains("selected")).to.be.true;

    const indicator = el.shadowRoot!.querySelector(".selected-indicator");
    expect(indicator).to.exist;
  });

  it("does not show selected indicator when not selected", async () => {
    const el = await fixture<DeviceCard>(html`
      <device-card name="Test Device"></device-card>
    `);

    const card = el.shadowRoot!.querySelector(".card");
    expect(card!.classList.contains("selected")).to.be.false;

    const indicator = el.shadowRoot!.querySelector(".selected-indicator");
    expect(indicator).to.be.null;
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

  it("stores deviceId property", async () => {
    const el = await fixture<DeviceCard>(html`
      <device-card deviceId="rpi5" name="Raspberry Pi 5"></device-card>
    `);

    expect(el.deviceId).to.equal("rpi5");
  });

  describe("radio group behaviour", () => {
    // fixtureSync + updateComplete rather than fixture(): a plain-<div> root
    // makes fixture() fall back to a requestAnimationFrame wait, which never
    // fires while the test page is backgrounded.
    const group = async (selected = -1) => {
      const root = fixtureSync<HTMLElement>(html`
        <div role="radiogroup">
          ${[0, 1, 2].map(
            (i) => html`
              <device-card
                .deviceId=${`d${i}`}
                .name=${`Device ${i}`}
                .selected=${i === selected}
              ></device-card>
            `
          )}
        </div>
      `);
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

    it("exposes radio semantics with aria-checked", async () => {
      const root = await group(1);
      const [first, second] = cards(root);

      expect(first!.getAttribute("role")).to.equal("radio");
      expect(first!.getAttribute("aria-checked")).to.equal("false");
      expect(second!.getAttribute("aria-checked")).to.equal("true");
    });

    it("makes the first card the tab stop when nothing is selected", async () => {
      const root = await group();
      const [first, second, third] = cards(root);

      expect(first!.getAttribute("tabindex")).to.equal("0");
      expect(second!.getAttribute("tabindex")).to.equal("-1");
      expect(third!.getAttribute("tabindex")).to.equal("-1");
    });

    it("moves the tab stop to the selected card", async () => {
      const root = await group(2);
      const [first, second, third] = cards(root);

      expect(first!.getAttribute("tabindex")).to.equal("-1");
      expect(second!.getAttribute("tabindex")).to.equal("-1");
      expect(third!.getAttribute("tabindex")).to.equal("0");
    });

    it("re-syncs siblings when the selection moves", async () => {
      const root = await group(0);
      const [first, second] = cards(root);

      first!.selected = false;
      second!.selected = true;
      await first!.updateComplete;
      await second!.updateComplete;

      expect(first!.getAttribute("tabindex")).to.equal("-1");
      expect(second!.getAttribute("tabindex")).to.equal("0");
    });

    it("activates the next card on ArrowRight and wraps at the end", async () => {
      const root = await group();
      const list = cards(root);
      const clicked: string[] = [];
      list.forEach((c) =>
        c.addEventListener("click", () => clicked.push(c.deviceId))
      );

      list[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight" })
      );
      list[2]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight" })
      );

      expect(clicked).to.deep.equal(["d1", "d0"]);
    });

    it("activates the previous card on ArrowUp", async () => {
      const root = await group();
      const list = cards(root);
      const clicked: string[] = [];
      list.forEach((c) =>
        c.addEventListener("click", () => clicked.push(c.deviceId))
      );

      list[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));

      expect(clicked).to.deep.equal(["d0"]);
    });

    it("jumps to the ends with Home and End", async () => {
      const root = await group();
      const list = cards(root);
      const clicked: string[] = [];
      list.forEach((c) =>
        c.addEventListener("click", () => clicked.push(c.deviceId))
      );

      list[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
      list[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));

      expect(clicked).to.deep.equal(["d2", "d0"]);
    });

    it("activates on Enter", async () => {
      const root = await group();
      const list = cards(root);
      let clicks = 0;
      list[1]!.addEventListener("click", () => clicks++);

      list[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

      expect(clicks).to.equal(1);
    });
  });
});
