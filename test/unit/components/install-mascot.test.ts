import { expect, fixture } from "@open-wc/testing";
import {
  renderCasitaFocusing,
  renderCasitaHappy,
  renderCasitaSad,
} from "../../../src/components/install-mascot.js";
import type { CasitaMascot } from "../../../src/components/casita-mascot.js";

describe("install-mascot", () => {
  for (const [name, renderMood, mood] of [
    ["working", renderCasitaFocusing, "focusing"],
    ["happy", renderCasitaHappy, "happy"],
    ["sad", renderCasitaSad, "problem"],
  ] as const) {
    it(`shows the ${mood} Casita for the ${name} state`, async () => {
      const el = await fixture<CasitaMascot>(renderMood());
      expect(el.tagName).to.equal("CASITA-MASCOT");
      expect(el.mood).to.equal(mood);
    });
  }
});
