import { expect } from "@open-wc/testing";
import * as icons from "../../../src/utils/icons.js";

describe("icons", () => {
  it("holds a path for every icon, and each only once", () => {
    const paths = Object.values(icons);

    expect(paths).to.not.be.empty;
    for (const path of paths) expect(path).to.match(/^M[\d.-]/);
    // A path under two names is a copy
    expect(new Set(paths).size).to.equal(paths.length);
  });
});
