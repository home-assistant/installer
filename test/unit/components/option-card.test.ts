import { expect, fixture, html } from "@open-wc/testing";
import { render } from "lit";
import "../../../src/components/option-card.js";
import type { OptionCard } from "../../../src/components/option-card.js";
import { findByRole, fullA11ySnapshot } from "../helpers/a11y.js";

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

  it("renders a neutral category icon when no icon is set", async () => {
    const el = await fixture<OptionCard>(html`
      <option-card heading="No Icon"></option-card>
    `);

    expect(el.shadowRoot!.querySelector("ha-svg-icon")!.path).to.not.be.empty;
  });

  // An attribute in a template isn't type-checked, so a misspelled icon can
  // still arrive
  for (const icon of ["dockr", "constructor"]) {
    it(`falls back to the neutral icon for an unknown icon "${icon}"`, async () => {
      const neutral = await fixture<OptionCard>(html`
        <option-card heading="No Icon"></option-card>
      `);
      const el = await fixture<OptionCard>(html`
        <option-card heading="Unknown" icon=${icon}></option-card>
      `);

      expect(el.shadowRoot!.querySelector(".icon-file")).to.be.null;
      expect(el.shadowRoot!.querySelector("ha-svg-icon")!.path).to.equal(
        neutral.shadowRoot!.querySelector("ha-svg-icon")!.path
      );
    });
  }

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

  describe("accessible name and description", () => {
    it("is a button named by its heading and described by its description", async () => {
      await fixture<OptionCard>(html`
        <option-card
          heading="Proxmox server"
          description="Create a VM on your Proxmox virtualization server"
        ></option-card>
      `);

      const [button] = findByRole(await fullA11ySnapshot(), "button");
      expect(button!.name).to.equal("Proxmox server");
      expect(button!.description).to.equal(
        "Create a VM on your Proxmox virtualization server"
      );
    });

    it("is a link that says it opens in the browser when external", async () => {
      await fixture<OptionCard>(html`
        <option-card
          external
          heading="Synology NAS"
          description="Run Home Assistant Container on your Synology NAS"
        ></option-card>
      `);

      const snapshot = await fullA11ySnapshot();
      expect(findByRole(snapshot, "button")).to.be.empty;
      const [link] = findByRole(snapshot, "link");
      expect(link!.name).to.equal("Synology NAS");
      expect(link!.description).to.equal(
        "Opens in your browser. Run Home Assistant Container on your Synology NAS"
      );
    });
  });

  describe("keyboard operability", () => {
    function card(el: OptionCard) {
      return el.shadowRoot!.querySelector<HTMLElement>(".card")!;
    }

    function press(el: OptionCard, type: string, init: KeyboardEventInit) {
      const event = new KeyboardEvent(type, {
        bubbles: true,
        composed: true,
        cancelable: true,
        ...init,
      });
      card(el).dispatchEvent(event);
      return event;
    }

    async function countedCard(external = false) {
      const el = await fixture<OptionCard>(html`
        <option-card heading="Proxmox" ?external=${external}></option-card>
      `);
      const clicks = { count: 0 };
      el.addEventListener("click", () => clicks.count++);
      return { el, clicks };
    }

    it("is reachable with Tab, and focusing the host focuses the card", async () => {
      const el = await fixture<OptionCard>(html`
        <option-card heading="Proxmox"></option-card>
      `);

      expect(card(el).getAttribute("role")).to.equal("button");
      expect(card(el).getAttribute("tabindex")).to.equal("0");
      expect(el.hasAttribute("role")).to.be.false;
      el.focus();
      expect(el.shadowRoot!.activeElement).to.equal(card(el));
    });

    it("activates on Enter as it goes down, once while held", async () => {
      const { el, clicks } = await countedCard();

      expect(press(el, "keydown", { key: "Enter" }).defaultPrevented).to.be
        .true;
      expect(clicks.count).to.equal(1);
      press(el, "keydown", { key: "Enter", repeat: true });
      press(el, "keydown", { key: "Enter", repeat: true });
      press(el, "keyup", { key: "Enter" });
      expect(clicks.count).to.equal(1);
    });

    it("activates on Space as it comes up, once while held", async () => {
      const { el, clicks } = await countedCard();

      // Without scrolling the page
      expect(press(el, "keydown", { key: " " }).defaultPrevented).to.be.true;
      press(el, "keydown", { key: " ", repeat: true });
      press(el, "keydown", { key: " ", repeat: true });
      expect(clicks.count).to.equal(0);
      press(el, "keyup", { key: " " });
      expect(clicks.count).to.equal(1);
      // Only a press that started on the card counts
      press(el, "keyup", { key: " " });
      expect(clicks.count).to.equal(1);
    });

    it("drops a Space press when the focus moves on", async () => {
      const { el, clicks } = await countedCard();

      press(el, "keydown", { key: " " });
      card(el).dispatchEvent(new FocusEvent("blur"));
      press(el, "keyup", { key: " " });
      expect(clicks.count).to.equal(0);
    });

    it("leaves a held Space that began elsewhere alone", async () => {
      const { el, clicks } = await countedCard();

      // Without scrolling the page while it is held
      expect(press(el, "keydown", { key: " ", repeat: true }).defaultPrevented)
        .to.be.true;
      press(el, "keyup", { key: " " });
      expect(clicks.count).to.equal(0);
    });

    it("leaves Space to scroll when external, as a link does", async () => {
      const { el, clicks } = await countedCard(true);

      expect(press(el, "keydown", { key: " " }).defaultPrevented).to.be.false;
      press(el, "keyup", { key: " " });
      expect(clicks.count).to.equal(0);
      press(el, "keydown", { key: "Enter" });
      expect(clicks.count).to.equal(1);
    });

    it("ignores other keys", async () => {
      const { el, clicks } = await countedCard();

      press(el, "keydown", { key: "a" });
      press(el, "keydown", { key: "Tab" });
      press(el, "keyup", { key: "a" });

      expect(clicks.count).to.equal(0);
    });
  });
});
