import type { BlockDevice, HaosConfig } from "../api/types.js";
import { wizardState, type WizardSelections } from "../state/wizard-state.js";

/**
 * Snapshot of the drive the user picked, taken at selection time.
 *
 * The device id doubles as the path handed to the backend (`/dev/sda`,
 * `disk2`, `\\.\PhysicalDrive1`), and the OS is free to hand that same path to
 * a different device once the original is unplugged. Compare the hardware
 * serial when available, along with the size, model and vendor.
 *
 * `undefined` means the value is unknown.
 */
export interface DriveIdentity {
  id: string;
  name: string;
  size?: number;
  model?: string;
  vendor?: string;
  serial?: string;
}

/**
 * Vendor and model as one label, like "SanDisk Ultra". Models often start with
 * their vendor already ("Samsung EVO Plus"), so it isn't said twice.
 */
export function driveModelLabel(
  vendor: string | null | undefined,
  model: string | null | undefined
): string {
  const vendorInModel =
    !!vendor &&
    `${(model ?? "").toLowerCase()} `.startsWith(`${vendor.toLowerCase()} `);
  return [vendorInModel ? "" : vendor, model].filter(Boolean).join(" ");
}

export function driveIdentity(drive: BlockDevice): DriveIdentity {
  return {
    id: drive.id,
    name: drive.name,
    size: drive.size,
    // The backend sends null for a value the device does not report.
    model: drive.model ?? undefined,
    vendor: drive.vendor ?? undefined,
    serial: drive.serial ?? undefined,
  };
}

/**
 * Whether the current snapshot still matches the selected device.
 *
 * `name` is deliberately excluded: it is a display label some enumerators
 * build from the mount state, so it can change while the device does not.
 * An unknown size never matches, since every enumerated device has one.
 * Only require a serial when it was known at selection time.
 */
export function isSameDrive(
  selected: DriveIdentity,
  current: DriveIdentity
): boolean {
  return (
    selected.id === current.id &&
    selected.size !== undefined &&
    selected.size === current.size &&
    selected.model === current.model &&
    selected.vendor === current.vendor &&
    (selected.serial === undefined || selected.serial === current.serial)
  );
}

export type DriveFit =
  | "unavailable"
  | "too-small"
  | "below-recommended"
  | "recommended";

/** Nominal capacity allows 5% for manufacturer-reserved space. Keep in sync
 * with HaosConfig::minimum_reported_storage_bytes in hai-core. */
function reportedCapacityFloor(nominal: number): number {
  return nominal - Math.floor(nominal / 20);
}

/** Compare reported bytes; display rounding must never decide eligibility. */
export function getDriveFit(
  size: number | undefined,
  config?: HaosConfig
): DriveFit {
  if (
    size === undefined ||
    !Number.isFinite(size) ||
    size <= 0 ||
    !config ||
    !Number.isFinite(config.minimum_storage_bytes) ||
    config.minimum_storage_bytes <= 0 ||
    !Number.isFinite(config.recommended_storage_bytes) ||
    config.recommended_storage_bytes < config.minimum_storage_bytes
  )
    return "unavailable";
  if (size < reportedCapacityFloor(config.minimum_storage_bytes))
    return "too-small";
  if (size < reportedCapacityFloor(config.recommended_storage_bytes))
    return "below-recommended";
  return "recommended";
}

/**
 * Enumeration returns every disk, internal ones included, so this is the gate
 * for selection and the pre-erase re-checks. Small removable drives remain
 * visible in the picker, but cannot be selected.
 */
export function isEligibleFlashTarget(
  drive: BlockDevice,
  config?: HaosConfig
): boolean {
  const fit = getDriveFit(drive.size, config);
  return (
    drive.removable && (fit === "below-recommended" || fit === "recommended")
  );
}

/**
 * The eligible drive in `drives` that is still the one described by
 * `identity`.
 */
export function findDrive(
  drives: BlockDevice[],
  identity: DriveIdentity,
  config?: HaosConfig
): BlockDevice | null {
  return (
    drives
      .filter((drive) => isEligibleFlashTarget(drive, config))
      .find((drive) => isSameDrive(identity, driveIdentity(drive))) ?? null
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
    size: selections.driveSize,
    model: selections.driveModel,
    vendor: selections.driveVendor,
    serial: selections.driveSerial,
  };
}

/** Record the full identity, not just the path, so it can be re-checked later. */
export function storeDriveSelection(drive: BlockDevice) {
  const identity = driveIdentity(drive);
  wizardState.setSelections({
    drive: identity.id,
    driveName: identity.name,
    driveSize: identity.size,
    driveModel: identity.model,
    driveVendor: identity.vendor,
    driveSerial: identity.serial,
    driveType: drive.device_type,
  });
}

export function clearDriveSelection() {
  wizardState.setSelections({
    drive: undefined,
    driveName: undefined,
    driveSize: undefined,
    driveModel: undefined,
    driveVendor: undefined,
    driveSerial: undefined,
    driveType: undefined,
  });
}
