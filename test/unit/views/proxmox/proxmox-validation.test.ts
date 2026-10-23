import { expect } from "@open-wc/testing";
import {
  CORE_OPTIONS,
  MEMORY_OPTIONS_MB,
  coreOptionsFor,
} from "../../../../src/views/proxmox/proxmox-validation.js";

describe("proxmox-validation", () => {
  describe("coreOptionsFor", () => {
    it("offers no more cores than the node has", () => {
      expect(coreOptionsFor(8)).to.deep.equal([2, 4, 6, 8]);
      expect(coreOptionsFor(1)).to.deep.equal([1]);
      expect(coreOptionsFor(null)).to.equal(CORE_OPTIONS);
    });

    // A new array renders every slider again
    it("gives the same array for the same CPU count", () => {
      expect(coreOptionsFor(6)).to.equal(coreOptionsFor(6));
      expect(coreOptionsFor(6)).not.to.equal(coreOptionsFor(12));
    });
  });

  it("offers up to 32 GB of memory", () => {
    expect(MEMORY_OPTIONS_MB).to.deep.equal([
      2048, 4096, 6144, 8192, 12288, 16384, 24576, 32768,
    ]);
  });
});
