import { expect, fixtureSync, html } from "@open-wc/testing";
import {
  MOCK_BLOCK_DEVICES,
  MOCK_HAOS_RELEASE,
  MOCK_MANIFEST,
} from "../../../src/api/mock-data.js";
import type { BlockDevice } from "../../../src/api/types.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import { storeDriveSelection } from "../../../src/utils/drive-selection.js";
import "../../../src/views/sbc/confirmation-view.js";
import "../../../src/views/utm/utm-confirm-view.js";
import "../../../src/views/proxmox/proxmox-confirm-view.js";
import { mockTauriIpc, restoreTauriIpc, settle } from "../tauri-ipc.js";
import { expectReadsLeftToRight } from "../helpers/bidi.js";

describe("installation confirmation views", () => {
  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  for (const flow of ["sbc", "vm", "proxmox"] as const) {
    for (const failRelease of [false, true]) {
      it(`keeps ${flow} selections visible when release lookup ${failRelease ? "fails" : "succeeds"}`, async () => {
        wizardState.startFlow(flow);
        storeDriveSelection(MOCK_BLOCK_DEVICES[0]);
        wizardState.setSelection("deviceName", MOCK_MANIFEST.devices[0].name);
        wizardState.setSelection("deviceConfig", MOCK_MANIFEST.devices[0].haos);
        wizardState.setSelection("vmName", "Test Home Assistant");
        mockTauriIpc((cmd) => {
          // UTM asks for the release of the board its download will use
          expect(cmd).to.equal(
            flow === "vm" ? "get_utm_haos_release" : "get_haos_release"
          );
          return failRelease
            ? Promise.reject("Release unavailable")
            : MOCK_HAOS_RELEASE;
        });
        const el = fixtureSync(
          flow === "sbc"
            ? html`<confirmation-view></confirmation-view>`
            : flow === "vm"
              ? html`<utm-confirm-view></utm-confirm-view>`
              : html`<proxmox-confirm-view></proxmox-confirm-view>`
        );
        await settle();
        expect(el.shadowRoot!.textContent).to.contain(
          `Version ${failRelease ? "Unknown" : MOCK_HAOS_RELEASE.version}`
        );
        expect(el.shadowRoot!.textContent).to.contain(
          flow === "sbc" ? MOCK_MANIFEST.devices[0].name : "Test Home Assistant"
        );
        if (flow === "sbc") {
          expect(el.shadowRoot!.textContent).to.contain(
            MOCK_BLOCK_DEVICES[0].id
          );
          expect(el.shadowRoot!.textContent).to.contain(
            MOCK_BLOCK_DEVICES[0].name
          );
        }
      });
    }
  }

  it("shows the selected drive's kind as its icon", async () => {
    const usb = MOCK_BLOCK_DEVICES.find(
      (drive) => drive.device_type === "usb_drive"
    )!;
    const sd = MOCK_BLOCK_DEVICES.find(
      (drive) => drive.device_type === "sd_card"
    )!;
    for (const [drive, viewBox] of [
      [usb, "0 0 192.756 192.756"],
      [sd, "0 0 24 24"],
    ] as const) {
      wizardState.startFlow("sbc");
      storeDriveSelection(drive);
      wizardState.setSelection("deviceConfig", MOCK_MANIFEST.devices[0].haos);
      mockTauriIpc(() => MOCK_HAOS_RELEASE);
      const el = fixtureSync(html`<confirmation-view></confirmation-view>`);
      await settle();
      // The drive is the second summary row, after the device
      const icon = el
        .shadowRoot!.querySelectorAll(".summary-row")[1]
        .querySelector(".icon-container svg")!;
      expect(icon.getAttribute("viewBox"), drive.device_type).to.equal(viewBox);
      el.remove();
      restoreTauriIpc();
    }
  });

  it("lists the Wi-Fi network only for a board that can use it", async () => {
    for (const [board, listed] of [
      ["rpi5-64", true],
      ["odroid-n2", false],
    ] as const) {
      wizardState.startFlow("sbc");
      storeDriveSelection(MOCK_BLOCK_DEVICES[0]);
      wizardState.setSelection("deviceConfig", {
        board,
        minimum_storage_bytes: 1_000_000_000,
        recommended_storage_bytes: 1_000_000_000,
      });
      wizardState.setSelection("wifi", {
        ssid: "Garden-Net",
        password: "12345678",
      });
      mockTauriIpc(() => MOCK_HAOS_RELEASE);
      const el = fixtureSync(html`<confirmation-view></confirmation-view>`);
      await settle();
      const text = el.shadowRoot!.textContent!;
      expect(text.includes("Wi-Fi"), board).to.equal(listed);
      expect(text.includes("Garden-Net"), board).to.equal(listed);
      expect(text).not.to.contain("12345678");
    }
  });

  it("reads the drive path left to right in a right-to-left language", async () => {
    wizardState.startFlow("sbc");
    storeDriveSelection({ ...MOCK_BLOCK_DEVICES[0], id: "/dev/sdb" });
    wizardState.setSelection("deviceConfig", MOCK_MANIFEST.devices[0].haos);
    mockTauriIpc(() => MOCK_HAOS_RELEASE);
    const el = fixtureSync(
      html`<confirmation-view dir="rtl"></confirmation-view>`
    );
    await settle();

    expectReadsLeftToRight(el.shadowRoot!.querySelector(".drive-path")!);
  });

  async function confirmDrive(drive: BlockDevice) {
    wizardState.startFlow("sbc");
    storeDriveSelection(drive);
    wizardState.setSelection("deviceConfig", MOCK_MANIFEST.devices[0].haos);
    mockTauriIpc(() => MOCK_HAOS_RELEASE);
    const el = fixtureSync(html`<confirmation-view></confirmation-view>`);
    await settle();
    return el.shadowRoot!.querySelector("inline-notice");
  }

  it("warns that a drive without a serial can't be told apart", async () => {
    const notice = await confirmDrive({
      ...MOCK_BLOCK_DEVICES[0],
      serial: null,
    });
    expect(notice!.textContent).to.contain("doesn't report a serial number");
  });

  it("does not warn about a drive with a serial", async () => {
    expect(await confirmDrive(MOCK_BLOCK_DEVICES[0])).to.equal(null);
  });
});
