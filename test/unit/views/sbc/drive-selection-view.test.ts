import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import "../../../../src/views/sbc/drive-selection-view.js";
import type { DriveSelectionView } from "../../../../src/views/sbc/drive-selection-view.js";
import { MOCK_BLOCK_DEVICES } from "../../../../src/api/mock-data.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import { storeDriveSelection } from "../../../../src/utils/drive-selection.js";

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

const selectedIds = (el: DriveSelectionView) =>
  [...el.shadowRoot!.querySelectorAll("drive-card")]
    .filter((card) => (card as HTMLElement & { selected: boolean }).selected)
    .map((card) => (card as HTMLElement & { driveId: string }).driveId);

describe("drive-selection-view", () => {
  beforeEach(() => wizardState.startFlow("sbc"));
  afterEach(() => wizardState.reset());

  it("renders and shows loading or error state", async () => {
    const el = await fixture<DriveSelectionView>(html`
      <drive-selection-view></drive-selection-view>
    `);

    // Component will either be in loading state, error state (no Tauri in test env),
    // or have loaded devices
    const loading = el.shadowRoot!.querySelector(".loading");
    const error = el.shadowRoot!.querySelector(".error");
    const list = el.shadowRoot!.querySelector(".drives-list");

    // One of these should exist
    expect(loading || error || list).to.exist;
  });

  it("has the correct host styles", async () => {
    const el = await fixture<DriveSelectionView>(html`
      <drive-selection-view></drive-selection-view>
    `);

    const styles = getComputedStyle(el);
    expect(styles.display).to.equal("flex");
  });

  it("stores the full identity of the drive the user picks", async () => {
    const el = await mountLoaded();

    const card = el.shadowRoot!.querySelector("drive-card") as HTMLElement & {
      driveId: string;
    };
    const picked = MOCK_BLOCK_DEVICES.find((d) => d.id === card.driveId)!;
    card.click();
    await el.updateComplete;

    // The path alone is not enough to recognise the device later.
    const selections = wizardState.getState().selections;
    expect(selections.drive).to.equal(picked.id);
    expect(selections.driveName).to.equal(picked.name);
    expect(selections.driveSize).to.equal(picked.size);
    expect(selections.driveModel).to.equal(picked.model);
    expect(selections.driveVendor).to.equal(picked.vendor);
  });

  describe("stale selections", () => {
    it("keeps a selection whose drive is still connected", async () => {
      storeDriveSelection(CONNECTED);

      const el = await mountLoaded();

      expect(wizardState.getState().selections.drive).to.equal(CONNECTED.id);
      expect(selectedIds(el)).to.deep.equal([CONNECTED.id]);
      expect(el.shadowRoot!.querySelector(".notice")).to.not.exist;
    });

    it("clears a selection whose drive is gone", async () => {
      storeDriveSelection({ ...CONNECTED, id: "mock-unplugged" });

      const el = await mountLoaded();

      expect(wizardState.getState().selections.drive).to.be.undefined;
      expect(selectedIds(el)).to.be.empty;
      expect(el.shadowRoot!.querySelector(".notice")).to.exist;
    });

    // The F8 scenario: the stick that was selected is unplugged and another
    // one takes over its path, so the id still enumerates but names a
    // different disk. Erasing it would destroy a drive the user never chose.
    it("clears a selection whose path now names a different disk", async () => {
      storeDriveSelection({
        ...CONNECTED,
        size: 8 * 1000 * 1000 * 1000,
        model: "Some Older Card",
      });

      const el = await mountLoaded();

      expect(wizardState.getState().selections.drive).to.be.undefined;
      expect(selectedIds(el)).to.be.empty;
      expect(el.shadowRoot!.querySelector(".notice")).to.exist;
    });

    it("re-checks the selection on refresh, not just on mount", async () => {
      storeDriveSelection(CONNECTED);
      const el = await mountLoaded();
      expect(selectedIds(el)).to.deep.equal([CONNECTED.id]);

      // The device behind the stored path changes while the view is open.
      wizardState.setSelection("driveModel", "Swapped Out");

      const refresh = el.shadowRoot!.querySelector(
        ".drives-header wa-button"
      ) as HTMLElement;
      refresh.click();

      await waitUntil(
        () => wizardState.getState().selections.drive === undefined,
        "refresh never dropped the stale selection"
      );
      await el.updateComplete;
      expect(selectedIds(el)).to.be.empty;
      expect(el.shadowRoot!.querySelector(".notice")).to.exist;
    });

    it("drops the notice once a new drive is picked", async () => {
      storeDriveSelection({ ...CONNECTED, id: "mock-unplugged" });
      const el = await mountLoaded();
      expect(el.shadowRoot!.querySelector(".notice")).to.exist;

      (el.shadowRoot!.querySelector("drive-card") as HTMLElement).click();
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector(".notice")).to.not.exist;
      expect(wizardState.getState().selections.drive).to.exist;
    });
  });
});
