import type { BlockDevice } from "../api/types.js";
import { wizardState, type WizardSelections } from "../state/wizard-state.js";

/**
 * Snapshot of the drive the user picked, taken at selection time.
 *
 * The device id doubles as the path handed to the backend (`/dev/sda`,
 * `disk2`, `\\.\PhysicalDrive1`), and the OS is free to hand that same path to
 * a different device once the original is unplugged. `BlockDevice` carries no
 * serial number, so identity is the id plus every other field that
 * distinguishes two devices that could end up sharing it.
 */
export interface DriveIdentity {
  id: string;
  name: string;
  size: number;
  model: string;
  vendor: string;
}

export function driveIdentity(drive: BlockDevice): DriveIdentity {
  return {
    id: drive.id,
    name: drive.name,
    size: drive.size,
    model: drive.model || "",
    vendor: drive.vendor || "",
  };
}

/**
 * Whether two snapshots describe the same physical device.
 *
 * `name` is deliberately excluded: it is a display label some enumerators
 * build from the mount state, so it can change while the device does not.
 */
export function isSameDrive(a: DriveIdentity, b: DriveIdentity): boolean {
  return (
    a.id === b.id &&
    a.size === b.size &&
    a.model === b.model &&
    a.vendor === b.vendor
  );
}

/** The drive in `drives` that is still the one described by `identity`. */
export function findDrive(
  drives: BlockDevice[],
  identity: DriveIdentity
): BlockDevice | null {
  return (
    drives.find((drive) => isSameDrive(driveIdentity(drive), identity)) ?? null
  );
}

/** The stored selection, or null when nothing is selected. */
export function readDriveSelection(
  selections: WizardSelections
): DriveIdentity | null {
  if (!selections.drive) {
    return null;
  }
  return {
    id: selections.drive,
    name: selections.driveName || "",
    size: selections.driveSize || 0,
    model: selections.driveModel || "",
    vendor: selections.driveVendor || "",
  };
}

/** Record the full identity, not just the path, so it can be re-checked later. */
export function storeDriveSelection(drive: BlockDevice) {
  const identity = driveIdentity(drive);
  wizardState.setSelection("drive", identity.id);
  wizardState.setSelection("driveName", identity.name);
  wizardState.setSelection("driveSize", identity.size);
  wizardState.setSelection("driveModel", identity.model);
  wizardState.setSelection("driveVendor", identity.vendor);
}

export function clearDriveSelection() {
  wizardState.setSelection("drive", undefined);
  wizardState.setSelection("driveName", undefined);
  wizardState.setSelection("driveSize", undefined);
  wizardState.setSelection("driveModel", undefined);
  wizardState.setSelection("driveVendor", undefined);
}
