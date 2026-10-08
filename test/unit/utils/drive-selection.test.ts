import { expect } from "@open-wc/testing";
import type { BlockDevice } from "../../../src/api/types.js";
import { MOCK_MANIFEST } from "../../../src/api/mock-data.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import {
  driveIdentity,
  findDrive,
  isSameDrive,
  getDriveFit,
  readDriveSelection,
  storeDriveSelection,
} from "../../../src/utils/drive-selection.js";

const config = MOCK_MANIFEST.devices[0].haos;

const makeDrive = (overrides: Partial<BlockDevice> = {}): BlockDevice => ({
  id: "/dev/sda",
  name: "USB Drive",
  size: 32 * 1000 * 1000 * 1000,
  device_type: "usb_drive",
  removable: true,
  model: "Ultra Fit",
  vendor: "SanDisk",
  ...overrides,
});

describe("drive-selection", () => {
  afterEach(() => wizardState.reset());

  describe("isSameDrive", () => {
    it("rejects another device that took over the same path", () => {
      expect(
        isSameDrive(
          driveIdentity(makeDrive()),
          driveIdentity(makeDrive({ model: "Cruzer Blade" }))
        )
      ).to.be.false;
    });

    it("ignores the display name, which can change with mount state", () => {
      expect(
        isSameDrive(
          driveIdentity(makeDrive()),
          driveIdentity(makeDrive({ name: "SANDISK (E:)" }))
        )
      ).to.be.true;
    });

    it("never matches an unknown size", () => {
      const unknown = { ...driveIdentity(makeDrive()), size: undefined };
      expect(isSameDrive(unknown, driveIdentity(makeDrive()))).to.be.false;
    });
  });

  // The re-checks before erasing must accept exactly what the picker offers,
  // even when a drive it would hide matches on every identifying field.
  it("finds only drives the picker would offer", () => {
    for (const hidden of [
      makeDrive({ removable: false }),
      makeDrive({ size: 15_200_000_000 - 1 }),
    ]) {
      expect(findDrive([hidden], driveIdentity(hidden), config)).to.be.null;
    }
    expect(findDrive([makeDrive()], driveIdentity(makeDrive()), config)).to
      .exist;
  });

  it("uses per-board nominal capacities with exact reported-byte boundaries", () => {
    const minimum = 15_200_000_000;
    const recommended = 30_400_000_000;
    expect(getDriveFit(minimum - 1, config)).to.equal("too-small");
    expect(getDriveFit(minimum, config)).to.equal("below-recommended");
    expect(getDriveFit(recommended - 1, config)).to.equal("below-recommended");
    expect(getDriveFit(recommended, config)).to.equal("recommended");
    expect(
      getDriveFit(minimum, {
        ...config,
        minimum_storage_bytes: config.recommended_storage_bytes,
      })
    ).to.equal("too-small");
  });

  it("accepts the reported capacity of nominal 16 GB and 32 GB media", () => {
    for (const size of [15_600_000_000, 15_931_539_456, 16_000_000_000]) {
      expect(getDriveFit(size, config)).to.equal("below-recommended");
    }
    expect(getDriveFit(31_914_983_424, config)).to.equal("recommended");
    expect(getDriveFit(8_000_000_000, config)).to.equal("too-small");
  });

  it("fails closed when capacity or board requirements are unknown", () => {
    for (const size of [undefined, 0, -1, NaN, Infinity]) {
      expect(getDriveFit(size, config)).to.equal("unavailable");
    }
    expect(getDriveFit(32_000_000_000)).to.equal("unavailable");
    expect(findDrive([makeDrive()], driveIdentity(makeDrive()))).to.be.null;
  });

  it("stores the full identity, not just the path", () => {
    const drive = makeDrive();
    storeDriveSelection(drive);

    expect(readDriveSelection(wizardState.getState().selections)).to.deep.equal(
      driveIdentity(drive)
    );
  });
});
