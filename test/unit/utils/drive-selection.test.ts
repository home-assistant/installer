import { expect } from "@open-wc/testing";
import type { BlockDevice } from "../../../src/api/types.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import {
  clearDriveSelection,
  driveIdentity,
  findDrive,
  isSameDrive,
  readDriveSelection,
  storeDriveSelection,
} from "../../../src/utils/drive-selection.js";

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

  describe("driveIdentity", () => {
    it("captures the identifying fields", () => {
      expect(driveIdentity(makeDrive())).to.deep.equal({
        id: "/dev/sda",
        name: "USB Drive",
        size: 32 * 1000 * 1000 * 1000,
        model: "Ultra Fit",
        vendor: "SanDisk",
      });
    });

    it("normalises absent model and vendor to empty strings", () => {
      const identity = driveIdentity(
        makeDrive({ model: undefined, vendor: undefined })
      );
      expect(identity.model).to.equal("");
      expect(identity.vendor).to.equal("");
    });
  });

  describe("isSameDrive", () => {
    it("matches an unchanged device", () => {
      expect(
        isSameDrive(driveIdentity(makeDrive()), driveIdentity(makeDrive()))
      ).to.be.true;
    });

    // The bug this guards: the OS hands a reused path to a different stick.
    it("rejects the same path reporting a different size", () => {
      expect(
        isSameDrive(
          driveIdentity(makeDrive()),
          driveIdentity(makeDrive({ size: 8 * 1000 * 1000 * 1000 }))
        )
      ).to.be.false;
    });

    it("rejects the same path reporting a different model", () => {
      expect(
        isSameDrive(
          driveIdentity(makeDrive()),
          driveIdentity(makeDrive({ model: "Cruzer Blade" }))
        )
      ).to.be.false;
    });

    it("rejects the same path reporting a different vendor", () => {
      expect(
        isSameDrive(
          driveIdentity(makeDrive()),
          driveIdentity(makeDrive({ vendor: "Kingston" }))
        )
      ).to.be.false;
    });

    it("rejects a different path", () => {
      expect(
        isSameDrive(
          driveIdentity(makeDrive()),
          driveIdentity(makeDrive({ id: "/dev/sdb" }))
        )
      ).to.be.false;
    });

    // `name` is a display label some enumerators derive from mount state, so
    // it can change while the device underneath does not.
    it("ignores the display name", () => {
      expect(
        isSameDrive(
          driveIdentity(makeDrive()),
          driveIdentity(makeDrive({ name: "SANDISK (E:)" }))
        )
      ).to.be.true;
    });
  });

  describe("findDrive", () => {
    const drives = [
      makeDrive(),
      makeDrive({ id: "/dev/sdb", model: "Extreme", size: 64 }),
    ];

    it("returns the still-present device", () => {
      const found = findDrive(drives, driveIdentity(drives[1]));
      expect(found).to.equal(drives[1]);
    });

    it("returns null when the device is gone", () => {
      const found = findDrive(
        drives,
        driveIdentity(makeDrive({ id: "/dev/sdz" }))
      );
      expect(found).to.be.null;
    });

    it("returns null when the path was handed to another device", () => {
      const found = findDrive(
        drives,
        driveIdentity(makeDrive({ model: "Some Other Stick" }))
      );
      expect(found).to.be.null;
    });

    it("returns null for an empty device list", () => {
      expect(findDrive([], driveIdentity(makeDrive()))).to.be.null;
    });
  });

  describe("stored selection", () => {
    it("reads back nothing when no drive is selected", () => {
      expect(readDriveSelection(wizardState.getState().selections)).to.be.null;
    });

    it("round-trips the full identity, not just the path", () => {
      const drive = makeDrive();
      storeDriveSelection(drive);

      const selections = wizardState.getState().selections;
      expect(selections.drive).to.equal("/dev/sda");
      expect(selections.driveName).to.equal("USB Drive");
      expect(selections.driveSize).to.equal(32 * 1000 * 1000 * 1000);
      expect(selections.driveModel).to.equal("Ultra Fit");
      expect(selections.driveVendor).to.equal("SanDisk");

      expect(readDriveSelection(selections)).to.deep.equal(
        driveIdentity(drive)
      );
    });

    it("clears every drive field", () => {
      storeDriveSelection(makeDrive());
      clearDriveSelection();

      const selections = wizardState.getState().selections;
      expect(selections.drive).to.be.undefined;
      expect(selections.driveName).to.be.undefined;
      expect(selections.driveSize).to.be.undefined;
      expect(selections.driveModel).to.be.undefined;
      expect(selections.driveVendor).to.be.undefined;
      expect(readDriveSelection(selections)).to.be.null;
    });
  });
});
