import { expect } from "@open-wc/testing";
import type { BlockDevice } from "../../../src/api/types.js";
import { MOCK_MANIFEST } from "../../../src/api/mock-data.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import {
  driveIdentity,
  clearDriveSelection,
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
  serial: "STICK-A",
  ...overrides,
});

describe("drive-selection", () => {
  afterEach(() => wizardState.reset());

  describe("isSameDrive", () => {
    it("rejects an identical stick or a missing previously known serial", () => {
      const selected = driveIdentity(makeDrive());
      for (const serial of ["STICK-B", null, undefined]) {
        expect(isSameDrive(selected, driveIdentity(makeDrive({ serial })))).to
          .be.false;
      }
      expect(isSameDrive(selected, driveIdentity(makeDrive()))).to.be.true;
    });

    it("keeps the existing fallback for drives without a serial", () => {
      expect(
        isSameDrive(
          driveIdentity(makeDrive({ serial: null, model: null, vendor: null })),
          driveIdentity(
            makeDrive({
              serial: undefined,
              model: undefined,
              vendor: undefined,
            })
          )
        )
      ).to.be.true;
    });

    it("accepts a newly discovered serial but still checks the other metadata", () => {
      const selected = driveIdentity(makeDrive({ serial: null }));
      expect(isSameDrive(selected, driveIdentity(makeDrive()))).to.be.true;
      for (const change of [
        { id: "/dev/sdb" },
        { size: 1 },
        { model: null },
        { vendor: null },
      ]) {
        expect(isSameDrive(selected, driveIdentity(makeDrive(change)))).to.be
          .false;
      }
    });

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

  it("uses the selected serial when finding a drive", () => {
    const known = makeDrive();
    const unknown = makeDrive({ serial: null });
    expect(findDrive([known], driveIdentity(unknown), config)).to.equal(known);
    expect(findDrive([unknown], driveIdentity(known), config)).to.be.null;
    expect(
      findDrive(
        [makeDrive({ serial: "STICK-B" })],
        driveIdentity(known),
        config
      )
    ).to.be.null;
  });

  it("stores the full identity, not just the path", () => {
    const drive = makeDrive();
    storeDriveSelection(drive);

    expect(readDriveSelection(wizardState.getState().selections)).to.deep.equal(
      driveIdentity(drive)
    );
  });

  it("clears the serial when clearing or replacing the selection", () => {
    storeDriveSelection(makeDrive());
    clearDriveSelection();
    expect(wizardState.getState().selections.driveSerial).to.be.undefined;
    storeDriveSelection(makeDrive());
    storeDriveSelection(makeDrive({ serial: null }));
    expect(readDriveSelection(wizardState.getState().selections)?.serial).to.be
      .undefined;
  });
});
