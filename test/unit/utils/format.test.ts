import { expect } from "@open-wc/testing";
import {
  formatDiskSize,
  formatMemory,
  formatRam,
} from "../../../src/utils/format.js";

describe("utils/format", () => {
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
});
