import { expect } from "@open-wc/testing";
import { formatBytes } from "../../../src/api/commands.js";

describe("api/commands", () => {
  describe("formatBytes", () => {
    it("formats 0 bytes", () => {
      expect(formatBytes(0)).to.equal("0 B");
    });

    it("formats bytes", () => {
      expect(formatBytes(500)).to.equal("500 B");
    });

    it("formats kilobytes", () => {
      expect(formatBytes(1000)).to.equal("1 KB");
      expect(formatBytes(1500)).to.equal("1.5 KB");
    });

    it("formats megabytes", () => {
      expect(formatBytes(1000000)).to.equal("1 MB");
      expect(formatBytes(1500000)).to.equal("1.5 MB");
    });

    it("formats gigabytes", () => {
      expect(formatBytes(1000000000)).to.equal("1 GB");
      expect(formatBytes(16000000000)).to.equal("16 GB");
      expect(formatBytes(32000000000)).to.equal("32 GB");
    });

    it("formats terabytes", () => {
      expect(formatBytes(1000000000000)).to.equal("1 TB");
    });

    it("does not round a drive up to a capacity threshold", () => {
      expect(formatBytes(16_000_000_000 - 1)).to.equal("15.9 GB");
      expect(formatBytes(32_000_000_000 - 1)).to.equal("31.9 GB");
    });

    it("handles invalid and oversized input without an undefined unit", () => {
      for (const invalid of [NaN, Infinity, -1]) {
        expect(formatBytes(invalid)).to.equal("Unknown size");
      }
      expect(formatBytes(1_000_000_000_000_000)).to.equal("1000 TB");
    });
  });
});
