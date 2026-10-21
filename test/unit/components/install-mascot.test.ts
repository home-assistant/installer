import { expect, fixture, fixtureSync } from "@open-wc/testing";
import {
  renderCasitaHappy,
  renderCasitaSad,
  renderCasitaThinking,
} from "../../../src/components/install-mascot.js";
import type { CasitaMascot } from "../../../src/components/casita-mascot.js";

describe("install-mascot", () => {
  it("shows a focusing Casita thinking about the current stage", async () => {
    // Sync: awaiting a plain element waits for an animation frame, which a
    // background test page may not get
    const el = fixtureSync<HTMLDivElement>(
      renderCasitaThinking("Writing image")
    );
    const mascot = el.querySelector<CasitaMascot>("casita-mascot")!;
    await mascot.updateComplete;
    expect(mascot.mood).to.equal("focusing");
    expect(
      el.querySelector(".thinking-cloud .cloud-text")!.textContent!.trim()
    ).to.equal("Writing image...");
  });

  for (const [name, render, mood] of [
    ["happy", renderCasitaHappy, "happy"],
    ["sad", renderCasitaSad, "problem"],
  ] as const) {
    it(`shows the ${mood} Casita for the ${name} outcome`, async () => {
      const el = await fixture<CasitaMascot>(render());
      expect(el.tagName).to.equal("CASITA-MASCOT");
      expect(el.mood).to.equal(mood);
    });
  }
});
