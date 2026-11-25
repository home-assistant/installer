import { expect, fixture, html } from "@open-wc/testing";
import { emulateMedia } from "@web/test-runner-commands";
import "../../../src/components/casita-mascot.js";
import type { CasitaMascot } from "../../../src/components/casita-mascot.js";

const drawing = (el: CasitaMascot) =>
  el.shadowRoot!.querySelector("svg")!.innerHTML;

const houseFill = (el: CasitaMascot) =>
  el.shadowRoot!.querySelector("svg path")!.getAttribute("fill");

describe("casita-mascot", () => {
  afterEach(() => emulateMedia({ reducedMotion: "no-preference" }));

  it("draws Casita decoratively", async () => {
    const el = await fixture<CasitaMascot>(
      html`<casita-mascot mood="happy"></casita-mascot>`
    );
    const svg = el.shadowRoot!.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).to.equal("true");
    expect(svg.querySelectorAll("path").length).to.be.greaterThan(3);
    expect(el.shadowRoot!.querySelector("img")).to.not.exist;
  });

  describe("with reduced motion", () => {
    beforeEach(() => emulateMedia({ reducedMotion: "reduce" }));

    it("holds still", async () => {
      const el = await fixture<CasitaMascot>(
        html`<casita-mascot mood="happy"></casita-mascot>`
      );
      const before = drawing(el);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(drawing(el)).to.equal(before);
    });

    it("switches mood at once", async () => {
      const el = await fixture<CasitaMascot>(
        html`<casita-mascot mood="happy"></casita-mascot>`
      );
      expect(houseFill(el)).to.equal("rgb(24 188 242)");
      el.mood = "problem";
      await el.updateComplete;
      expect(houseFill(el)).to.equal("rgb(247 147 30)");
    });

    for (const mood of ["unknown", "constructor", "__proto__"]) {
      it(`falls back to happy for ${mood}`, async () => {
        const happy = await fixture<CasitaMascot>(
          html`<casita-mascot mood="happy"></casita-mascot>`
        );
        const el = await fixture<CasitaMascot>(
          html`<casita-mascot mood=${mood}></casita-mascot>`
        );
        expect(drawing(el)).to.equal(drawing(happy));
      });
    }
  });

  it("changes mood without resizing", async () => {
    const el = await fixture<CasitaMascot>(
      html`<casita-mascot></casita-mascot>`
    );
    const before = el.getBoundingClientRect();
    el.mood = "problem";
    await el.updateComplete;
    const after = el.getBoundingClientRect();
    expect(after.width).to.equal(before.width);
    expect(after.height).to.equal(before.height);
  });

  it("draws nothing once removed", async () => {
    const el = await fixture<CasitaMascot>(
      html`<casita-mascot></casita-mascot>`
    );
    const svg = el.shadowRoot!.querySelector("svg")!;
    el.remove();
    expect(svg.childElementCount).to.equal(0);
  });
});
