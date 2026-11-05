import { expect } from "@open-wc/testing";
import {
  memoryOptionsUpTo,
  proxmoxVmConfig,
  utmVmConfig,
} from "../../../src/state/vm-defaults.js";

describe("vm-defaults", () => {
  describe("memoryOptionsUpTo", () => {
    it("offers the sizes that fit, the largest included", () => {
      expect(memoryOptionsUpTo(14336)).to.deep.equal([
        2048, 4096, 6144, 8192, 12288,
      ]);
      expect(memoryOptionsUpTo(65536)).to.have.length(10);
    });

    it("offers nothing below the smallest size", () => {
      expect(memoryOptionsUpTo(0)).to.deep.equal([]);
    });
  });

  describe("utmVmConfig", () => {
    it("falls back to the defaults before the configure step saves", () => {
      expect(utmVmConfig({})).to.deep.equal({
        name: "Home Assistant",
        cpu_cores: 4,
        memory_mb: 4096,
        disk_size_gb: 32,
        auto_start: false,
      });
    });

    it("uses what the configure step saved, with the name as typed", () => {
      expect(
        utmVmConfig({
          vmName: " My Home ",
          cpuCores: 6,
          memoryMb: 8192,
          diskSizeGb: 128,
        })
      ).to.deep.equal({
        name: " My Home ",
        cpu_cores: 6,
        memory_mb: 8192,
        disk_size_gb: 128,
        auto_start: false,
      });
    });

    it("never hands UTM an empty name", () => {
      expect(utmVmConfig({ vmName: "" }).name).to.equal("Home Assistant");
    });
  });

  describe("proxmoxVmConfig", () => {
    it("guesses no node or storage before the configure step picks them", () => {
      const config = proxmoxVmConfig({});
      expect(config.node).to.equal("");
      expect(config.storage).to.equal("");
    });

    it("uses the node and storage the configure step picked", () => {
      const config = proxmoxVmConfig({
        proxmoxNode: "pve2",
        proxmoxStorage: "local-lvm",
      });
      expect(config.node).to.equal("pve2");
      expect(config.storage).to.equal("local-lvm");
    });
  });
});
