import { expect } from "@open-wc/testing";
import { setViewport } from "@web/test-runner-commands";
import * as breakpoints from "../../../src/utils/breakpoints.js";

const gutter = () =>
  getComputedStyle(document.documentElement)
    .getPropertyValue("--ha-page-gutter")
    .trim();

describe("utils/breakpoints", () => {
  afterEach(() => setViewport({ width: 800, height: 600 }));

  it("are all conditions the browser understands", () => {
    for (const [name, condition] of Object.entries(breakpoints)) {
      expect(matchMedia(condition.cssText).media, name).to.not.equal("not all");
    }
  });

  // styles.css can't import the module, so it repeats the width
  it("narrow the page gutter where the components take a window as narrow", async () => {
    const query = breakpoints.narrowWindow.cssText;

    await setViewport({ width: 600, height: 600 });
    expect(matchMedia(query).matches).to.equal(true);
    expect(gutter()).to.equal("1rem");

    await setViewport({ width: 601, height: 600 });
    expect(matchMedia(query).matches).to.equal(false);
    expect(gutter()).to.equal("2rem");
  });
});
