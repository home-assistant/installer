import { expect, fixture, fixtureSync } from "@open-wc/testing";
import { render } from "lit";
import {
  renderCasitaHappy,
  renderCasitaSad,
  renderCasitaThinking,
  thinkingCloudStyles,
} from "../../../src/components/install-mascot.js";
import type { CasitaMascot } from "../../../src/components/casita-mascot.js";
import { InstallProgress } from "../../../src/components/install-progress.js";

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

  // Its sheet comes with the markup, so the cloud doesn't depend on which
  // view renders it
  it("draws the cloud with its own sheet alone", () => {
    // A plain container: fixture() would wait for a frame, which a background
    // test page never paints
    const host = document.body.appendChild(document.createElement("div"));
    const root = host.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = [thinkingCloudStyles.styleSheet!];
    render(renderCasitaThinking("Writing image"), root);
    try {
      const style = (selector: string) =>
        getComputedStyle(root.querySelector(selector)!);
      expect(style(".thinking-cloud").position).to.equal("absolute");
      expect(style(".thinking-cloud").width).to.equal("200px");
      expect(style(".bump-center").backgroundColor).to.equal(
        "rgb(24, 188, 242)"
      );
      expect(style(".bump-center").width).to.equal("140px");
      expect(style(".cloud-text").color).to.equal("rgb(255, 255, 255)");
    } finally {
      host.remove();
    }
  });

  it("is styled in the install progress by the same sheet", () => {
    expect(InstallProgress.elementStyles).to.include(thinkingCloudStyles);
  });

  for (const [name, renderMood, mood] of [
    ["happy", renderCasitaHappy, "happy"],
    ["sad", renderCasitaSad, "problem"],
  ] as const) {
    it(`shows the ${mood} Casita for the ${name} outcome`, async () => {
      const el = await fixture<CasitaMascot>(renderMood());
      expect(el.tagName).to.equal("CASITA-MASCOT");
      expect(el.mood).to.equal(mood);
    });
  }
});
