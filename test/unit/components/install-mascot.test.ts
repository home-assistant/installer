import { expect, fixture } from "@open-wc/testing";
import { renderCasita } from "../../../src/components/install-mascot.js";
import type { CasitaMascot } from "../../../src/components/casita-mascot.js";

describe("install-mascot", () => {
  it("shows Casita in the given mood", async () => {
    const el = await fixture<CasitaMascot>(renderCasita("focusing"));
    expect(el.tagName).to.equal("CASITA-MASCOT");
    expect(el.mood).to.equal("focusing");
    expect(el.celebrate).to.be.false;
  });

  it("can celebrate", async () => {
    const el = await fixture<CasitaMascot>(renderCasita("happy", true));
    expect(el.celebrate).to.be.true;
  });
});
