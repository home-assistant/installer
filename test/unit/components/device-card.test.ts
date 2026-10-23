import { expect, fixture, html } from "@open-wc/testing";
import "../../../src/components/device-card.js";
import type { DeviceCard } from "../../../src/components/device-card.js";
import { findByRole, fullA11ySnapshot } from "../helpers/a11y.js";

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

  it("has the correct structure", async () => {
    const el = await fixture<DeviceCard>(html`
      <device-card name="Test Device"></device-card>
    `);

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

  it("is a button reachable with Tab", async () => {
    const el = await fixture<DeviceCard>(html`
      <device-card value="rpi5" name="Raspberry Pi 5"></device-card>
    `);

    expect(el.getAttribute("role")).to.equal("button");
    expect(el.tabIndex).to.equal(0);
  });

  it("is named by the device alone", async () => {
    await fixture<DeviceCard>(html`
      <device-card
        value="rpi5"
        name="Raspberry Pi 5"
        image="/assets/devices/raspberry_pi_5.png"
      ></device-card>
    `);

    const buttons = findByRole(await fullA11ySnapshot(), "button");
    expect(buttons.map((button) => button.name)).to.deep.equal([
      "Raspberry Pi 5",
    ]);
  });
});
