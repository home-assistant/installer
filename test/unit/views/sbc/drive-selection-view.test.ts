import { expect } from "@open-wc/testing";
import {
  isEligibleFlashTarget,
  MIN_DRIVE_SIZE_BYTES,
} from "../../../../src/views/sbc/drive-selection-view.js";
import type { BlockDevice } from "../../../../src/api/index.js";

function drive(overrides: Partial<BlockDevice> = {}): BlockDevice {
  return {
    id: "/dev/test",
    name: "Test drive",
    size: 64 * MIN_DRIVE_SIZE_BYTES,
    device_type: "usb_drive",
    removable: true,
    ...overrides,
  };
}

describe("drive-selection-view flash-target filter", () => {
  it("offers a removable drive at or above the size floor", () => {
    expect(isEligibleFlashTarget(drive({ size: MIN_DRIVE_SIZE_BYTES }))).to.be
      .true;
    expect(isEligibleFlashTarget(drive({ size: 64 * MIN_DRIVE_SIZE_BYTES }))).to
      .be.true;
  });

  it("hides a removable drive just below the size floor", () => {
    expect(isEligibleFlashTarget(drive({ size: MIN_DRIVE_SIZE_BYTES - 1 }))).to
      .be.false;
  });

  it("hides a non-removable drive even when large", () => {
    // Enumeration now returns internal disks; they must never be offered.
    expect(
      isEligibleFlashTarget(
        drive({ removable: false, size: 512 * MIN_DRIVE_SIZE_BYTES })
      )
    ).to.be.false;
  });
});
