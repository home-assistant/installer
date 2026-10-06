import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import {
  isEligibleFlashTarget,
  MIN_DRIVE_SIZE_BYTES,
} from "../../../../src/views/sbc/drive-selection-view.js";
import type { DriveSelectionView } from "../../../../src/views/sbc/drive-selection-view.js";
import { MOCK_BLOCK_DEVICES } from "../../../../src/api/mock-data.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import { storeDriveSelection } from "../../../../src/utils/drive-selection.js";
import type { BlockDevice } from "../../../../src/api/index.js";
import { flush, holdDeviceScan } from "../../helpers/hold-device-scan.js";

// Browser-only mode (no Tauri) serves MOCK_BLOCK_DEVICES, so those are the
// drives "connected" for the duration of these tests.
const CONNECTED = MOCK_BLOCK_DEVICES[0];

async function mountLoaded(): Promise<DriveSelectionView> {
  const el = await fixture<DriveSelectionView>(html`
    <drive-selection-view></drive-selection-view>
  `);
  await waitUntil(
    () => el.shadowRoot!.querySelectorAll("drive-card").length > 0,
    "drives never finished loading"
  );
  return el;
}

// The cards are radios in a <wa-radio-group>, so selection lives in
// `checked` and identity in `value`.
const selectedIds = (el: DriveSelectionView) =>
  [...el.shadowRoot!.querySelectorAll("drive-card")]
    .filter((card) => (card as HTMLElement & { checked: boolean }).checked)
    .map((card) => (card as HTMLElement & { value: string }).value);

describe("drive-selection-view", () => {
  beforeEach(() => wizardState.startFlow("sbc"));
  afterEach(() => wizardState.reset());

  it("keeps a selection whose drive is still connected", async () => {
    storeDriveSelection(CONNECTED);

    const el = await mountLoaded();

    expect(wizardState.getState().selections.drive).to.equal(CONNECTED.id);
    expect(selectedIds(el)).to.deep.equal([CONNECTED.id]);
    expect(el.shadowRoot!.querySelector(".notice")).to.not.exist;
  });

  it("clears a selection whose path now names a different disk", async () => {
    storeDriveSelection({ ...CONNECTED, model: "Some Older Card" });

    const el = await mountLoaded();

    expect(wizardState.getState().selections.drive).to.be.undefined;
    expect(selectedIds(el)).to.be.empty;
    expect(el.shadowRoot!.querySelector(".notice")).to.exist;
  });

  it("ignores a scan that finishes after the view is gone", async () => {
    const scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(html`
        <drive-selection-view></drive-selection-view>
      `);
      // The user cancels and starts over before the scan returns.
      el.remove();
      wizardState.startFlow("sbc");
      storeDriveSelection(CONNECTED);

      scan.reject(new Error("scan failed"));
      await flush();

      expect(wizardState.getState().selections.drive).to.equal(CONNECTED.id);
    } finally {
      scan.restore();
    }
  });

  it("announces a selection dropped on refresh through a live region", async () => {
    storeDriveSelection(CONNECTED);
    const el = await mountLoaded();

    // The region must already exist before the notice is inserted, or
    // assistive technology may not announce it.
    const region = el.shadowRoot!.querySelector('[role="status"]');
    expect(region).to.exist;

    wizardState.setSelection("driveModel", "Swapped Out");
    (
      el.shadowRoot!.querySelector(".drives-header wa-button") as HTMLElement
    ).click();
    await waitUntil(() => el.shadowRoot!.querySelector(".notice"));

    expect(wizardState.getState().selections.drive).to.be.undefined;
    expect(region!.querySelector(".notice")).to.exist;
    expect(
      region!.querySelector(".notice-icon")!.getAttribute("aria-hidden")
    ).to.equal("true");
  });
});

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
