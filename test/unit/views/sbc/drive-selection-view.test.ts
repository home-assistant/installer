import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import "../../../../src/views/sbc/drive-selection-view.js";
import type { DriveSelectionView } from "../../../../src/views/sbc/drive-selection-view.js";
import type { InlineNotice } from "../../../../src/components/inline-notice.js";
import {
  MOCK_BLOCK_DEVICES,
  MOCK_MANIFEST,
} from "../../../../src/api/mock-data.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import {
  isEligibleFlashTarget,
  storeDriveSelection,
} from "../../../../src/utils/drive-selection.js";
import type { BlockDevice } from "../../../../src/api/index.js";
import { flush, holdDeviceScan } from "../../helpers/hold-device-scan.js";
import { fullA11ySnapshot, headingOutline } from "../../helpers/a11y.js";
import { ipcError, mockTauriIpc, restoreTauriIpc } from "../../tauri-ipc.js";
import {
  diagnosticText,
  getDiagnostics,
  reportUrl,
} from "../../../../src/utils/diagnostics.js";

// Browser-only mode (no Tauri) serves MOCK_BLOCK_DEVICES, so those are the
// drives "connected" for the duration of these tests.
const CONNECTED = MOCK_BLOCK_DEVICES[0];
const config = MOCK_MANIFEST.devices[0].haos;

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
  beforeEach(() => {
    wizardState.startFlow("sbc");
    wizardState.setSelection("deviceConfig", config);
  });
  afterEach(() => wizardState.reset());

  it("shows Casita and refresh guidance when there are no drives", async () => {
    const scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      scan.resolve([]);
      await flush();
      expect(el.shadowRoot!.querySelector("casita-mascot")!.mood).to.equal(
        "sad"
      );
      expect(
        el.shadowRoot!.querySelector(".empty-title")!.textContent
      ).to.equal("No drives found");
      expect(
        el.shadowRoot!.querySelector(".empty-state wa-button")!.textContent
      ).to.include("Refresh");
    } finally {
      scan.restore();
    }
  });

  for (const [flow, installMethod, hint] of [
    ["sbc", undefined, "Insert an SD card or USB drive"],
    ["minipc", undefined, "Connect your drive using a USB adapter"],
    // Making a stick to boot the mini PC from: a stick is what's missing
    ["minipc", "usb-boot", "Insert a USB stick"],
  ] as const) {
    it(`says what to connect when no drive is found (${flow} ${installMethod ?? "drive"})`, async () => {
      wizardState.startFlow(flow);
      if (installMethod)
        wizardState.setSelection("installMethod", installMethod);
      const scan = holdDeviceScan();
      try {
        const el = await fixture<DriveSelectionView>(
          html`<drive-selection-view></drive-selection-view>`
        );
        scan.resolve([]);
        await flush();
        expect(
          el.shadowRoot!.querySelector(".empty-text")!.textContent
        ).to.contain(hint);
      } finally {
        scan.restore();
      }
    });
  }

  it("keeps focus on Refresh while it scans, and announces what it found", async () => {
    let scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      scan.resolve([]);
      await flush();
      const status = el.shadowRoot!.querySelector(".sr-only[role=status]")!;
      expect(status.textContent).to.contain("No drives found");
      // Read out, not shown: the empty state says it on screen
      expect(status.getBoundingClientRect().width).to.be.at.most(1);

      scan.restore();
      scan = holdDeviceScan();
      const refresh = el.shadowRoot!.querySelector(
        ".empty-state wa-button"
      ) as HTMLElement & { loading: boolean };
      refresh.focus();
      refresh.click();
      await el.updateComplete;

      // Not swapped for the full-page spinner, which took focus with it
      expect(refresh.isConnected).to.be.true;
      expect(refresh.loading).to.be.true;
      expect(el.shadowRoot!.activeElement).to.equal(refresh);
      expect(status.textContent).to.contain("Scanning for drives");

      // The list replaces the empty state: its own Refresh takes over
      scan.resolve([CONNECTED]);
      await waitUntil(() => !!el.shadowRoot!.querySelector("drive-card"));
      await el.updateComplete;
      expect(el.shadowRoot!.activeElement).to.equal(
        el.shadowRoot!.querySelector(".drives-header wa-button")
      );
      expect(status.textContent).to.contain("1 drive found");
    } finally {
      scan.restore();
    }
  });

  it("keeps focus through retries after a failed scan, and reads out each failure", async () => {
    const failure = ipcError("io", "The drive scan failed.", true);
    const root = (el: DriveSelectionView) => el.shadowRoot!;
    const alertText = (el: DriveSelectionView) =>
      root(el).querySelector("[data-focus-alert]")?.textContent?.trim() ?? "";
    let scan = holdDeviceScan();
    const rescan = async (el: DriveSelectionView, selector: string) => {
      const button = root(el).querySelector(selector) as HTMLElement;
      button.focus();
      scan.restore();
      scan = holdDeviceScan();
      button.click();
      await el.updateComplete;
      expect(root(el).activeElement === button).to.be.true;
      return button;
    };
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      scan.reject(failure as unknown as Error);
      await waitUntil(() => !!alertText(el));

      // The same failure again: emptied meanwhile, so it is new to read out
      await rescan(el, ".error wa-button");
      expect(alertText(el)).to.equal("");
      scan.reject(failure as unknown as Error);
      await waitUntil(() => !!alertText(el));
      expect(
        root(el).activeElement === root(el).querySelector("[data-focus-alert]")
      ).to.be.true;

      // Then nothing found: the empty state's Refresh takes over
      await rescan(el, ".error wa-button");
      scan.resolve([]);
      await waitUntil(() => !!root(el).querySelector(".empty-state"));
      await el.updateComplete;
      expect(
        root(el).activeElement ===
          root(el).querySelector(".empty-state wa-button")
      ).to.be.true;

      // Then a drive: the list's Refresh takes over
      await rescan(el, ".empty-state wa-button");
      scan.resolve([CONNECTED]);
      await waitUntil(() => !!root(el).querySelector("drive-card"));
      await el.updateComplete;
      expect(
        root(el).activeElement ===
          root(el).querySelector(".drives-header wa-button")
      ).to.be.true;
    } finally {
      scan.restore();
    }
  });

  describe("without administrator rights", () => {
    const notElevated = ipcError(
      "permission_denied",
      "Administrator access is required to write a drive.",
      false,
      { message_key: "backend.disk.run_as_administrator", message_params: {} }
    );

    afterEach(() => restoreTauriIpc());

    async function mountRefused(relaunch: () => unknown) {
      const calls: string[] = [];
      mockTauriIpc((cmd) => {
        calls.push(cmd);
        if (cmd === "list_block_devices") return Promise.reject(notElevated);
        if (cmd === "relaunch_as_admin") return relaunch();
        throw new Error(`unexpected command ${cmd}`);
      });
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      await waitUntil(
        () => el.shadowRoot!.querySelector(".admin-needed"),
        "the scan was never refused"
      );
      await el.updateComplete;
      return { el, calls };
    }

    for (const flow of ["sbc", "minipc"] as const) {
      it(`offers to restart as administrator (${flow})`, async () => {
        wizardState.startFlow(flow);
        const { el, calls } = await mountRefused(() => undefined);
        const root = el.shadowRoot!;
        const notice = root.querySelector(".admin-needed")!;
        expect(notice.textContent).to.contain("needs administrator access");
        expect(notice.textContent).to.contain(
          "starts again from the beginning"
        );
        // Read out when it appears, like any failed scan
        expect(root.activeElement === notice).to.be.true;
        // Scanning again can't help: the rights last until a restart
        expect(root.querySelector(".error") === null).to.be.true;
        const buttons = [...root.querySelectorAll("wa-button")];
        expect(
          buttons.map((button) => button.textContent!.trim())
        ).to.deep.equal(["Restart as administrator"]);

        (buttons[0] as HTMLElement).click();
        await waitUntil(() => calls.includes("relaunch_as_admin"));
      });
    }

    it("says so when the restart is declined", async () => {
      const declined = "The installer wasn't restarted as administrator.";
      const { el } = await mountRefused(() =>
        Promise.reject(ipcError("relaunch_cancelled", declined, true))
      );
      const root = el.shadowRoot!;
      (root.querySelector(".admin-needed wa-button") as HTMLElement).click();
      await waitUntil(() => root.querySelector(".relaunch-error"));
      await el.updateComplete;

      const error = root.querySelector(".relaunch-error")!;
      expect(error.textContent!.trim()).to.equal(declined);
      // Read out on its own, not the notice again
      expect(root.activeElement === error).to.be.true;
    });

    it("leaves other permission errors to the failed scan", async () => {
      mockTauriIpc((cmd) => {
        if (cmd === "list_block_devices") {
          return Promise.reject(
            ipcError("permission_denied", "Not authorized", false, {
              message_key: "backend.disk.not_authorized",
              message_params: {},
            })
          );
        }
        throw new Error(`unexpected command ${cmd}`);
      });
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      await waitUntil(() => el.shadowRoot!.querySelector(".error-message"));

      expect(el.shadowRoot!.querySelector(".admin-needed") === null).to.be.true;
    });
  });

  it("keeps a selection whose drive is still connected", async () => {
    storeDriveSelection(CONNECTED);

    const el = await mountLoaded();

    expect(wizardState.getState().selections.drive).to.equal(CONNECTED.id);
    expect(selectedIds(el)).to.deep.equal([CONNECTED.id]);
    expect(el.shadowRoot!.querySelector('inline-notice[variant="error"]')).to
      .not.exist;
  });

  it("holds Next until a scan has checked the selection", async () => {
    storeDriveSelection(CONNECTED);
    const scanReady = () => wizardState.getState().selections.driveScanReady;
    let scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      expect(scanReady()).to.not.be.true;
      scan.resolve([CONNECTED]);
      await waitUntil(() => scanReady() === true, "scan never finished");
      expect(wizardState.getState().selections.drive).to.equal(CONNECTED.id);

      // A refresh can drop the drive just the same
      scan.restore();
      scan = holdDeviceScan();
      (
        el.shadowRoot!.querySelector(".drives-header wa-button") as HTMLElement
      ).click();
      expect(scanReady()).to.equal(false);
      scan.resolve([CONNECTED]);
      await waitUntil(() => scanReady() === true, "refresh never finished");
    } finally {
      scan.restore();
    }
  });

  it("explains a drive the install could not confirm", async () => {
    wizardState.setSelection("driveSelectionLost", true);
    const scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      // Inserted only after the region is in place, so it is announced
      const region = el.shadowRoot!.querySelector('[role="status"]')!;
      expect(region.querySelector("inline-notice")).to.not.exist;

      scan.resolve([CONNECTED]);
      await waitUntil(
        () => region.querySelector('inline-notice[variant="error"]'),
        "the notice never showed"
      );
      expect(wizardState.getState().selections.driveSelectionLost).to.be
        .undefined;

      el.shadowRoot!.querySelector("drive-card")!.click();
      await waitUntil(
        () => wizardState.getState().selections.drive === CONNECTED.id
      );
      await el.updateComplete;
      expect(region.querySelector("inline-notice")).to.not.exist;
    } finally {
      scan.restore();
    }
  });

  it("clears a selection whose path now names a different disk", async () => {
    storeDriveSelection({ ...CONNECTED, model: "Some Older Card" });

    const el = await mountLoaded();

    expect(wizardState.getState().selections.drive).to.be.undefined;
    expect(selectedIds(el)).to.be.empty;
    expect(el.shadowRoot!.querySelector('inline-notice[variant="error"]')).to
      .exist;
  });

  it("clears a selection when an identical model has a different serial", async () => {
    storeDriveSelection({ ...CONNECTED, serial: "ANOTHER-STICK" });
    const el = await mountLoaded();
    expect(wizardState.getState().selections.drive).to.be.undefined;
    expect(wizardState.getState().selections.driveSerial).to.be.undefined;
    expect(selectedIds(el)).to.be.empty;
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
    await waitUntil(() =>
      el.shadowRoot!.querySelector('inline-notice[variant="error"]')
    );

    expect(wizardState.getState().selections.drive).to.be.undefined;
    const notice = region!.querySelector<InlineNotice>(
      'inline-notice[variant="error"]'
    );
    expect(notice).to.exist;
    expect(notice!.icon).to.equal("🔌");
  });

  it("keeps the check on the selected drive when a refresh reorders the list", async () => {
    const GB = 1000 * 1000 * 1000;
    const kept: BlockDevice = {
      ...CONNECTED,
      id: "kept",
      size: 128 * GB,
      serial: "KEPT",
    };
    const unplugged: BlockDevice = {
      ...CONNECTED,
      id: "unplugged",
      size: 64 * GB,
      serial: "UNPLUGGED",
    };
    const plugged: BlockDevice = {
      ...CONNECTED,
      id: "plugged",
      size: 256 * GB,
      serial: "PLUGGED",
    };
    const cardIds = (el: DriveSelectionView) =>
      [...el.shadowRoot!.querySelectorAll("drive-card")].map(
        (card) => (card as HTMLElement & { value: string }).value
      );

    storeDriveSelection(kept);
    let scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      scan.resolve([unplugged, kept]);
      await waitUntil(() => cardIds(el).length === 2);
      expect(cardIds(el)).to.deep.equal(["kept", "unplugged"]);
      await waitUntil(() => selectedIds(el).length > 0);
      expect(selectedIds(el)).to.deep.equal(["kept"]);

      // Same number of drives, but the kept one moves down a place
      scan.restore();
      scan = holdDeviceScan();
      (
        el.shadowRoot!.querySelector(".drives-header wa-button") as HTMLElement
      ).click();
      scan.resolve([kept, plugged]);
      await waitUntil(() => cardIds(el)[0] === "plugged");
      await el.updateComplete;

      expect(cardIds(el)).to.deep.equal(["plugged", "kept"]);
      expect(wizardState.getState().selections.drive).to.equal("kept");
      expect(selectedIds(el)).to.deep.equal(["kept"]);
    } finally {
      scan.restore();
    }
  });

  it("shows each drive's path, so two identical sticks can be told apart", async () => {
    const scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      scan.resolve([drive({ id: "/dev/sdb" }), drive({ id: "/dev/sdc" })]);
      await waitUntil(
        () => el.shadowRoot!.querySelectorAll("drive-card").length === 2
      );
      const cards = [...el.shadowRoot!.querySelectorAll("drive-card")];
      for (const card of cards) await card.updateComplete;

      expect(
        cards.map(
          (card) => card.shadowRoot!.querySelector(".path")!.textContent
        )
      ).to.deep.equal(["/dev/sdb", "/dev/sdc"]);
    } finally {
      scan.restore();
    }
  });

  // Moving by headings reaches the list, at the level of the instructions
  // a Home Assistant device shows above it. Chrome names the list's heading
  // as it shows it, in capitals.
  for (const [flow, outline] of [
    ["sbc", [[3, "AVAILABLE DRIVES"]]],
    [
      "ha-hardware",
      [
        [3, "Connect a microSD card"],
        [3, "AVAILABLE DRIVES"],
      ],
    ],
  ] as const) {
    it(`heads the ${flow} drive list under the step's heading`, async () => {
      wizardState.startFlow(flow);
      wizardState.setSelection("deviceConfig", config);
      if (flow === "ha-hardware")
        wizardState.setSelection("haHardware", "green");
      await mountLoaded();

      expect(headingOutline(await fullA11ySnapshot())).to.deep.equal([
        [2, "Select your drive"],
        ...outline,
      ]);
    });
  }

  it("keeps undersized drives visible and disables them with the board minimum", async () => {
    const scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      scan.resolve([
        drive({ id: "tiny", size: 500_000_000 }),
        drive({ id: "small", size: 8_000_000_000 }),
        drive({ id: "limited", size: config.minimum_storage_bytes }),
        drive({ id: "recommended", size: config.recommended_storage_bytes }),
        drive({ id: "internal", removable: false }),
      ]);
      await waitUntil(
        () => el.shadowRoot!.querySelectorAll("drive-card").length === 4
      );
      const cards = [...el.shadowRoot!.querySelectorAll("drive-card")];
      expect(cards.map((card) => card.value)).to.deep.equal([
        "recommended",
        "limited",
        "small",
        "tiny",
      ]);
      for (const card of cards) await card.updateComplete;
      expect(cards[2].disabled).to.be.true;
      expect(cards[3].disabled).to.be.true;
      expect(cards[2].shadowRoot!.textContent).to.contain(
        "Minimum 16 GB drive required"
      );
      expect(cards[1].disabled).to.be.false;
      expect(cards[1].shadowRoot!.textContent).to.contain(
        "A 32 GB drive is recommended"
      );
      expect(cards[0].shadowRoot!.querySelector(".capacity-warning")).to.not
        .exist;

      const group = el.shadowRoot!.querySelector("wa-radio-group")!;
      group.value = "small";
      group.dispatchEvent(new Event("change"));
      expect(wizardState.getState().selections.drive).to.be.undefined;
      cards[1].click();
      await waitUntil(
        () => wizardState.getState().selections.drive === "limited"
      );
    } finally {
      scan.restore();
    }
  });

  it("clears a restored selection that no longer meets the selected board minimum", async () => {
    storeDriveSelection(CONNECTED);
    wizardState.setSelection("deviceConfig", {
      ...config,
      minimum_storage_bytes: CONNECTED.size * 2,
      recommended_storage_bytes: CONNECTED.size * 2,
    });
    const el = await mountLoaded();
    expect(wizardState.getState().selections.drive).to.be.undefined;
    expect(selectedIds(el)).to.be.empty;
    // Still there, so not "no longer available": its card says why instead
    expect(el.shadowRoot!.querySelector('inline-notice[variant="error"]')).to
      .not.exist;
  });

  it("counts the drives that can be used apart from those found", async () => {
    const scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      scan.resolve([
        drive({ id: "big" }),
        drive({ id: "small", size: 8_000_000_000 }),
        drive({ id: "tiny", size: 500_000_000 }),
      ]);
      await waitUntil(() => el.shadowRoot!.querySelector("drive-card"));
      expect(
        el.shadowRoot!.querySelector(".sr-only[role=status]")!.textContent
      ).to.equal("3 drives found, 1 can be used");
      expect(el.shadowRoot!.querySelector(".no-usable-drive")).to.not.exist;
    } finally {
      scan.restore();
    }
  });

  it("says why no drive can be used, and continues from there", async () => {
    const root = (el: DriveSelectionView) => el.shadowRoot!;
    const status = (el: DriveSelectionView) =>
      root(el).querySelector(".sr-only[role=status]")!.textContent;
    const small = [
      drive({ id: "small", size: 8_000_000_000 }),
      drive({ id: "tiny", size: 500_000_000 }),
    ];
    let scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      scan.resolve(small);
      await waitUntil(() => root(el).querySelector(".no-usable-drive"));
      await el.updateComplete;
      const why = root(el).querySelector(".no-usable-drive")!;
      expect(why.textContent!.trim()).to.equal(
        "None of these drives can be used. You need a drive of at least 16 GB. Connect one and select Refresh."
      );
      expect(status(el)).to.equal("2 drives found, but none can be used");
      // Every card is disabled, so the group has no tab stop of its own
      expect(root(el).activeElement).to.equal(why);

      // The same again: Refresh keeps the focus, and the count is read out
      const refresh = root(el).querySelector(
        ".drives-header wa-button"
      ) as HTMLElement;
      refresh.focus();
      scan.restore();
      scan = holdDeviceScan();
      refresh.click();
      await el.updateComplete;
      expect(status(el)).to.contain("Scanning for drives");
      scan.resolve(small);
      await waitUntil(() => !status(el)!.includes("Scanning"));
      await el.updateComplete;
      expect(root(el).activeElement).to.equal(refresh);

      // A drive big enough: nothing left to explain
      scan.restore();
      scan = holdDeviceScan();
      refresh.click();
      scan.resolve([...small, drive({ id: "big" })]);
      await waitUntil(() => !root(el).querySelector(".no-usable-drive"));
      expect(status(el)).to.equal("3 drives found, 1 can be used");
      expect(root(el).activeElement).to.equal(refresh);
    } finally {
      scan.restore();
    }
  });

  it("says so of a single drive that can't be used", async () => {
    const scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      scan.resolve([drive({ size: 8_000_000_000 })]);
      await waitUntil(() => el.shadowRoot!.querySelector(".no-usable-drive"));
      expect(
        el.shadowRoot!.querySelector(".no-usable-drive")!.textContent
      ).to.contain("This drive can't be used. You need a drive of at least");
      expect(
        el.shadowRoot!.querySelector(".sr-only[role=status]")!.textContent
      ).to.equal("1 drive found, but it can't be used");
    } finally {
      scan.restore();
    }
  });

  it("says when the board's requirements are unknown", async () => {
    wizardState.setSelection("deviceConfig", undefined);
    const scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      scan.resolve([drive({ id: "a" }), drive({ id: "b" })]);
      await waitUntil(() => el.shadowRoot!.querySelector(".no-usable-drive"));
      expect(
        el.shadowRoot!.querySelector(".no-usable-drive")!.textContent!.trim()
      ).to.equal(
        "None of these drives can be used, because their capacity or the board's requirements are unavailable."
      );
    } finally {
      scan.restore();
    }
  });

  it("names both reasons when one drive is too small and another's capacity is unknown", async () => {
    const scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      scan.resolve([
        drive({ id: "small", size: 8_000_000_000 }),
        drive({ id: "unknown", size: 0 }),
      ]);
      await waitUntil(() => el.shadowRoot!.querySelector(".no-usable-drive"));
      expect(
        el.shadowRoot!.querySelector(".no-usable-drive")!.textContent!.trim()
      ).to.equal(
        "None of these drives can be used. You need a drive of at least 16 GB whose capacity can be read. Connect one and select Refresh."
      );
    } finally {
      scan.restore();
    }
  });

  it("keeps the selection through a failed scan, and holds Next until one confirms it", async () => {
    storeDriveSelection(CONNECTED);
    const root = (el: DriveSelectionView) => el.shadowRoot!;
    let scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      scan.reject(
        ipcError("io", "The drive scan failed.", true) as unknown as Error
      );
      await waitUntil(() => root(el).querySelector(".error-message"));
      await el.updateComplete;
      // Nothing says the drive is gone: the scan only couldn't tell
      expect(root(el).querySelector("inline-notice")).to.not.exist;
      expect(wizardState.getState().selections.drive).to.equal(CONNECTED.id);
      expect(wizardState.getState().selections.driveScanReady).to.not.be.true;

      scan.restore();
      scan = holdDeviceScan();
      (root(el).querySelector(".error wa-button") as HTMLElement).click();
      scan.resolve([CONNECTED]);
      await waitUntil(
        () => wizardState.getState().selections.driveScanReady === true
      );
      await waitUntil(() => selectedIds(el).length > 0);
      expect(selectedIds(el)).to.deep.equal([CONNECTED.id]);
      expect(root(el).querySelector("inline-notice")).to.not.exist;
    } finally {
      scan.restore();
    }
  });

  it("says a selection was cleared once a scan after a failure finds it gone", async () => {
    storeDriveSelection(CONNECTED);
    const root = (el: DriveSelectionView) => el.shadowRoot!;
    let scan = holdDeviceScan();
    try {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      scan.reject(
        ipcError("io", "The drive scan failed.", true) as unknown as Error
      );
      await waitUntil(() => root(el).querySelector(".error-message"));

      scan.restore();
      scan = holdDeviceScan();
      (root(el).querySelector(".error wa-button") as HTMLElement).click();
      scan.resolve([drive({ id: "other" })]);
      await waitUntil(() =>
        root(el).querySelector('inline-notice[variant="error"]')
      );
      expect(wizardState.getState().selections.drive).to.be.undefined;
      expect(wizardState.getState().selections.driveScanReady).to.be.true;
    } finally {
      scan.restore();
    }
  });
});

describe("drive-selection diagnostics", () => {
  afterEach(() => {
    restoreTauriIpc();
    wizardState.reset();
  });

  for (const kind of ["string", "Error", "unknown"] as const) {
    it(`records only an allowlisted category for a ${kind} scan rejection`, async () => {
      const message = `${kind === "unknown" ? "Unexpected scan failure" : "Permission denied"}: /home/private-user/image ticket=private-ticket`;
      const rejection = kind === "Error" ? new Error(message) : message;
      const calls: unknown[] = [];
      mockTauriIpc(
        (cmd, args) => {
          if (cmd === "list_block_devices") return Promise.reject(rejection);
          if (cmd === "log_frontend_event") {
            calls.push(args);
            return;
          }
          if (cmd === "get_diagnostics") {
            return {
              version: "0.1.0",
              os: "linux",
              os_version: "6.12",
              architecture: "x86_64",
              package_type: "AppImage",
              log_tail: "",
            };
          }
          throw new Error(cmd);
        },
        { includeLogs: true }
      );
      wizardState.startFlow("sbc");
      const el = await fixture<DriveSelectionView>(html`
        <drive-selection-view></drive-selection-view>
      `);
      await waitUntil(() => el.shadowRoot!.querySelector(".error-message"));
      // Unstructured rejections stay readable on screen; only the log is
      // limited to an allowlisted category
      expect(
        el.shadowRoot!.querySelector(".error-message")!.textContent!.trim()
      ).to.equal(message);

      const diagnostics = await getDiagnostics();
      const category =
        kind === "unknown" ? "operation_failed" : "permission_denied";
      expect(diagnostics.context).to.deep.equal({
        flow: "flash",
        stage: "preparing",
        error: category,
      });
      // A failed scan starts no install, so nothing logs a start
      expect(calls).to.have.length(1);
      expect(calls[0]).to.include({
        flow: "flash",
        stage: "preparing",
        outcome: "failed",
        error: category,
      });
      const exported =
        JSON.stringify(calls) +
        diagnosticText(diagnostics) +
        reportUrl(diagnostics).url;
      for (const privateValue of ["private-user", "private-ticket", "/home/"]) {
        expect(exported).not.to.contain(privateValue);
      }
    });
  }
});

function drive(overrides: Partial<BlockDevice> = {}): BlockDevice {
  return {
    id: "/dev/test",
    name: "Test drive",
    size: 64_000_000_000,
    device_type: "usb_drive",
    removable: true,
    model: null,
    vendor: null,
    serial: null,
    ...overrides,
  };
}

describe("drive-selection-view flash-target filter", () => {
  it("offers a removable drive at or above the board minimum", () => {
    expect(
      isEligibleFlashTarget(
        drive({ size: config.minimum_storage_bytes }),
        config
      )
    ).to.be.true;
    expect(isEligibleFlashTarget(drive({ size: 64_000_000_000 }), config)).to.be
      .true;
  });

  it("rejects a removable drive just below the board minimum", () => {
    expect(isEligibleFlashTarget(drive({ size: 15_200_000_000 - 1 }), config))
      .to.be.false;
  });

  it("hides a non-removable drive even when large", () => {
    // Enumeration now returns internal disks; they must never be offered.
    expect(
      isEligibleFlashTarget(
        drive({ removable: false, size: 512_000_000_000 }),
        config
      )
    ).to.be.false;
  });
});
