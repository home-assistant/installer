import { expect } from "@open-wc/testing";
import {
  formatBytes,
  formatDiskSize,
  formatFreeSpace,
  formatMemory,
  formatRam,
} from "../../../src/utils/format.js";

describe("utils/format", () => {
  describe("formatBytes", () => {
    it("formats 0 bytes", () => {
      expect(formatBytes(0)).to.equal("0 bytes");
    });

    it("formats bytes", () => {
      expect(formatBytes(500)).to.equal("500 bytes");
    });

    it("formats kilobytes", () => {
      expect(formatBytes(1000)).to.equal("1 kB");
      expect(formatBytes(1500)).to.equal("1.5 kB");
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

    it("formats speeds", () => {
      expect(formatBytes(500, true)).to.equal("500 bytes per second");
      expect(formatBytes(1500000, true)).to.equal("1.5 MB/s");
    });

    it("handles invalid and oversized input without an undefined unit", () => {
      for (const invalid of [NaN, Infinity, -1]) {
        expect(formatBytes(invalid)).to.equal("Unknown size");
      }
      expect(formatBytes(1_000_000_000_000_000)).to.equal("1000 TB");
    });
  });

  // The confirm steps used to round memory to whole GB (512 MB read as
  // 1 GB on Proxmox, 1536 MB as 2 GB on both), unlike the sliders
  for (const [mb, memory, ram] of [
    [512, "0.5 GB", "0.5 GB RAM"],
    [1536, "1.5 GB", "1.5 GB RAM"],
    [4096, "4 GB", "4 GB RAM"],
    [6144, "6 GB", "6 GB RAM"],
  ] as const) {
    it(`shows ${mb} MB of memory as ${memory}`, () => {
      expect(formatMemory(mb)).to.equal(memory);
      expect(formatRam(mb)).to.equal(ram);
    });
  }

  // Proxmox's confirm step used to show every disk in GB
  for (const [gb, size] of [
    [32, "32 GB"],
    [512, "512 GB"],
    [1000, "1,000 GB"],
    [1024, "1 TB"],
    [1536, "1.5 TB"],
    [2048, "2 TB"],
  ] as const) {
    it(`shows a ${gb} GB disk as ${size}`, () => {
      expect(formatDiskSize(gb)).to.equal(size);
    });
  }

  // Proxmox storage listed 34e9 bytes as 34 GB free, which has no room for
  // a 32 GB disk: those are GiB
  const GIB = 1024 ** 3;
  for (const [bytes, free] of [
    [0, "0 GB"],
    [34e9, "31.6 GB"],
    [32 * GIB - 1, "31.9 GB"],
    [32 * GIB, "32 GB"],
    [1000 * GIB, "1,000 GB"],
    [1024 * GIB - 1, "1,023.9 GB"],
    [1024 * GIB, "1 TB"],
    [2 * 1024 * GIB - 1, "1.9 TB"],
  ] as const) {
    it(`shows ${bytes} bytes free as ${free}, like the disk sizes`, () => {
      expect(formatFreeSpace(bytes)).to.equal(free);
    });
  }
});
