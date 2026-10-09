import { expect, fixture, html } from "@open-wc/testing";
import "../../../src/components/casita-mascot.js";
import type { CasitaMascot } from "../../../src/components/casita-mascot.js";

describe("casita-mascot", () => {
  for (const mood of [
    "happy",
    "grinning",
    "loving",
    "winking",
    "loading",
    "focusing",
    "sad",
    "problem",
  ]) {
    it(`renders the supplied ${mood} artwork decoratively`, async () => {
      const el = await fixture<CasitaMascot>(
        html`<casita-mascot mood=${mood}></casita-mascot>`
      );
      const img = el.shadowRoot!.querySelector("img")!;
      expect(img.getAttribute("src")).to.equal(
        `/assets/casita/${mood[0].toUpperCase()}${mood.slice(1)}.svg`
      );
      expect(img.alt).to.equal("");
      expect(el.shadowRoot!.querySelector("svg")).to.not.exist;
    });
  }

  for (const mood of ["unknown", "constructor", "__proto__"]) {
    it(`falls back to happy for ${mood}`, async () => {
      const el = await fixture<CasitaMascot>(
        html`<casita-mascot mood=${mood}></casita-mascot>`
      );
      expect(el.shadowRoot!.querySelector("img")!.getAttribute("src")).to.equal(
        "/assets/casita/Happy.svg"
      );
    });
  }

  it("updates the artwork without resizing the component", async () => {
    const el = await fixture<CasitaMascot>(
      html`<casita-mascot></casita-mascot>`
    );
    const before = el.getBoundingClientRect();
    el.mood = "problem";
    await el.updateComplete;
    const after = el.getBoundingClientRect();
    expect(after.width).to.equal(before.width);
    expect(after.height).to.equal(before.height);
    expect(el.shadowRoot!.querySelector("img")!.getAttribute("src")).to.include(
      "Problem.svg"
    );
  });
});
