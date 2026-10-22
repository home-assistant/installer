import { expect } from "@open-wc/testing";
import { utmVmConfig } from "../../../src/state/vm-defaults.js";

describe("vm-defaults", () => {
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
});
