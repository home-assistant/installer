import { expect } from "@open-wc/testing";
import {
  CORE_OPTIONS,
  MEMORY_OPTIONS_MB,
  checkedSetting,
  coreOptionsFor,
} from "../../../../src/views/proxmox/proxmox-validation.js";
import { ipcError } from "../../tauri-ipc.js";

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

  describe("checkedSetting", () => {
    const refusal = (message_key?: string) =>
      ipcError("proxmox_action_required", "Refused", false, { message_key });

    it("tells which setting a refusal is about", () => {
      expect(
        checkedSetting(refusal("backend.proxmox.vm_id_unavailable"))
      ).to.equal("vmId");
      expect(
        checkedSetting(refusal("backend.proxmox.storage_too_small"))
      ).to.equal("storage");
      expect(
        checkedSetting(refusal("backend.proxmox.storage_inactive"))
      ).to.equal("storage");
      expect(
        checkedSetting(refusal("backend.proxmox.invalid_vm_name"))
      ).to.equal("name");
    });

    it("leaves out what is no one setting's", () => {
      expect(checkedSetting(refusal("backend.proxmox.missing_privileges"))).to
        .be.undefined;
      expect(checkedSetting(refusal())).to.be.undefined;
      expect(checkedSetting(ipcError("proxmox_api", "Failed"))).to.be.undefined;
      // Only the catalog's own keys
      expect(checkedSetting(refusal("toString"))).to.be.undefined;
    });
  });
});
