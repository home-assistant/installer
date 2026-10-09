import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import "../../../../src/views/sbc/drive-selection-view.js";
import type { DriveSelectionView } from "../../../../src/views/sbc/drive-selection-view.js";
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
import { mockTauriIpc, restoreTauriIpc } from "../../tauri-ipc.js";
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
    await waitUntil(() => el.shadowRoot!.querySelector(".notice"));

    expect(wizardState.getState().selections.drive).to.be.undefined;
    expect(region!.querySelector(".notice")).to.exist;
    expect(
      region!.querySelector(".notice-icon")!.getAttribute("aria-hidden")
    ).to.equal("true");
  });

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
      expect(calls).to.have.length(2);
      expect(calls[1]).to.include({
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
