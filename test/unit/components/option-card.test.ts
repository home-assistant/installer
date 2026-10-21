import { expect, fixture, html } from "@open-wc/testing";
import { render } from "lit";
import "../../../src/components/option-card.js";
import type { OptionCard } from "../../../src/components/option-card.js";

describe("option-card", () => {
  it("renders with title and description", async () => {
    const el = await fixture<OptionCard>(html`
      <option-card
        heading="Test Title"
        description="Test Description"
      ></option-card>
    `);

    const title = el.shadowRoot!.querySelector(".title");
    const description = el.shadowRoot!.querySelector(".description");

    expect(title).to.exist;
    expect(title!.textContent).to.equal("Test Title");
    expect(description).to.exist;
    expect(description!.textContent).to.equal("Test Description");
    // A native title would add a tooltip over the whole card and repeat the
    // heading as its accessible description
    expect(el.hasAttribute("title")).to.be.false;
  });

  it("renders with an icon from the icon map", async () => {
    const el = await fixture<OptionCard>(html`
      <option-card heading="SBC" icon="sbc"></option-card>
    `);

    const img = el.shadowRoot!.querySelector(".icon-container img");
    expect(img).to.exist;
    expect(img!.getAttribute("src")).to.include("raspberry_pi_5.png");
    // Decorative: the title already names the button.
    expect(img!.getAttribute("alt")).to.equal("");
  });

  it("renders with a custom image", async () => {
    const el = await fixture<OptionCard>(html`
      <option-card heading="Custom" image="/custom/path.svg"></option-card>
    `);

    const img = el.shadowRoot!.querySelector(".icon-container img");
    expect(img).to.exist;
    expect(img!.getAttribute("src")).to.equal("/custom/path.svg");
    expect(img!.getAttribute("alt")).to.equal("");
  });

  it("renders a neutral category icon when no icon or image is provided", async () => {
    const el = await fixture<OptionCard>(html`
      <option-card heading="No Icon"></option-card>
    `);

    expect(el.shadowRoot!.querySelector("ha-svg-icon")!.path).to.not.be.empty;
  });

  for (const icon of ["minipc", "proxmox", "vm", "others"]) {
    it(`renders a decorative category icon for ${icon}`, async () => {
      const el = await fixture<OptionCard>(html`
        <option-card heading="Path" icon=${icon}></option-card>
      `);
      const graphic = el.shadowRoot!.querySelector("ha-svg-icon")!;
      await graphic.updateComplete;
      expect(graphic.path).to.not.be.empty;
      expect(
        graphic.shadowRoot!.querySelector("svg")!.getAttribute("aria-hidden")
      ).to.equal("true");
    });
  }

  it("has the correct card structure", async () => {
    const el = await fixture<OptionCard>(html`
      <option-card heading="Test"></option-card>
    `);

    const card = el.shadowRoot!.querySelector(".card");
    expect(card).to.exist;
    expect(card!.querySelector(".icon-container")).to.exist;
    expect(card!.querySelector(".title")).to.exist;
    expect(card!.querySelector(".description")).to.exist;
  });

  it("draws icon files in the same color as the MDI icons", async () => {
    const logo = await fixture<OptionCard>(html`
      <option-card heading="HA Hardware" icon="ha-hardware"></option-card>
    `);
    const docker = await fixture<OptionCard>(html`
      <option-card heading="Docker" icon="docker"></option-card>
    `);
    const minipc = await fixture<OptionCard>(html`
      <option-card heading="Mini PC" icon="minipc"></option-card>
    `);

    const file = logo.shadowRoot!.querySelector<HTMLElement>(".icon-file")!;
    expect(file.style.getPropertyValue("--icon-file")).to.include(
      "home-assistant-hardware.svg"
    );
    expect(
      docker.shadowRoot!.querySelector<HTMLElement>(".icon-file")!.style.cssText
    ).to.include("docker.svg");
    const mdi = minipc.shadowRoot!.querySelector("ha-svg-icon")!;
    expect(getComputedStyle(file).backgroundColor).to.equal(
      getComputedStyle(mdi).color
    );
  });

  it("ends level with the other cards in its row", async () => {
    // A plain container: fixture() would wait for a frame, which a background
    // test page never paints
    const grid = document.createElement("div");
    grid.style.cssText =
      "display: grid; grid-template-columns: 1fr 1fr; width: 400px";
    render(
      html`<option-card heading="Short" description="One line"></option-card>
        <option-card
          heading="Long"
          description="A description that wraps over several lines in a narrow card"
        ></option-card>`,
      grid
    );
    document.body.append(grid);
    try {
      const cards = [...grid.querySelectorAll("option-card")];
      await Promise.all(cards.map((card) => card.updateComplete));
      const [short, long] = cards.map((card) =>
        card.shadowRoot!.querySelector(".card")!.getBoundingClientRect()
      );

      expect(long.height).to.be.greaterThan(200);
      expect(short.bottom).to.equal(long.bottom);
    } finally {
      grid.remove();
    }
  });

  describe("keyboard operability", () => {
    it("exposes button semantics and is reachable with Tab", async () => {
      const el = await fixture<OptionCard>(html`
        <option-card heading="Proxmox"></option-card>
      `);

      expect(el.getAttribute("role")).to.equal("button");
      expect(el.getAttribute("tabindex")).to.equal("0");
    });

    it("activates on Enter and Space", async () => {
      const el = await fixture<OptionCard>(html`
        <option-card heading="Proxmox"></option-card>
      `);

      let clicks = 0;
      el.addEventListener("click", () => clicks++);

      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(clicks).to.equal(1);

      el.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
      expect(clicks).to.equal(2);
    });

    it("ignores other keys", async () => {
      const el = await fixture<OptionCard>(html`
        <option-card heading="Proxmox"></option-card>
      `);

      let clicks = 0;
      el.addEventListener("click", () => clicks++);

      el.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));

      expect(clicks).to.equal(0);
    });
  });
});
