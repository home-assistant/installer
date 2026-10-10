import {
  expect,
  fixture,
  fixtureCleanup,
  fixtureSync,
  html,
  waitUntil,
} from "@open-wc/testing";
import "../../../../src/views/ha-hardware/device-selection-view.js";
import "../../../../src/views/ha-hardware/connect-instructions.js";
import "../../../../src/views/ha-hardware/success-view.js";
import "../../../../src/views/sbc/confirmation-view.js";
import "../../../../src/views/sbc/drive-selection-view.js";
import "../../../../src/views/sbc/progress-view.js";
import type { HaHardwareConnectInstructions } from "../../../../src/views/ha-hardware/connect-instructions.js";
import {
  HA_HARDWARE,
  findHaHardware,
  installerConfig,
  type HaHardwareId,
} from "../../../../src/views/ha-hardware/hardware.js";
import {
  MOCK_BLOCK_DEVICES,
  MOCK_MANIFEST,
} from "../../../../src/api/mock-data.js";
import type { FlashRequest } from "../../../../src/api/types.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import {
  isEligibleFlashTarget,
  storeDriveSelection,
} from "../../../../src/utils/drive-selection.js";
import { deferred, mockTauriIpc, restoreTauriIpc } from "../../tauri-ipc.js";

function configFor(id: HaHardwareId) {
  const hardware = findHaHardware(id)!;
  if (hardware.installer) return installerConfig(hardware.installer);
  return MOCK_MANIFEST.devices.find(
    (device) => device.haos.board === hardware.manifestBoard
  )!.haos;
}

/** Selections as the device step leaves them. */
function select(id: HaHardwareId, name: string) {
  wizardState.startFlow("ha-hardware");
  wizardState.setSelection("device", findHaHardware(id)!.deviceId);
  wizardState.setSelection("haHardware", id);
  wizardState.setSelection("deviceName", name);
  wizardState.setSelection("deviceConfig", configFor(id));
}

const text = (root: ShadowRoot) => root.textContent!.replace(/\s+/g, " ");

describe("Home Assistant hardware views", () => {
  afterEach(() => {
    fixtureCleanup();
    restoreTauriIpc();
    wizardState.reset();
  });

  describe("device selection", () => {
    it("offers the Green, both Yellows and the Blue", async () => {
      wizardState.startFlow("ha-hardware");
      const el = await fixture(
        html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`
      );
      await waitUntil(() => el.shadowRoot!.querySelector("device-card"));
      const cards = [...el.shadowRoot!.querySelectorAll("device-card")];
      expect(cards.map((card) => card.value)).to.deep.equal([
        "ha-green",
        "ha-yellow-cm4",
        "ha-yellow-cm5",
        "ha-blue",
      ]);
      expect(cards.map((card) => card.name)).to.deep.equal([
        "Home Assistant Green",
        "Home Assistant Yellow with CM4",
        "Home Assistant Yellow with CM5",
        "Home Assistant Blue",
      ]);
    });

    for (const [value, id, board] of [
      ["ha-green", "green", "green-installer"],
      ["ha-yellow-cm4", "yellow-cm4", "yellow-installer"],
      // The installer only boots on a CM4; a CM5 gets Home Assistant OS
      ["ha-yellow-cm5", "yellow-cm5", "yellow"],
      ["ha-blue", "blue", "odroid-n2"],
    ] as const) {
      it(`selecting ${value} stores the ${board} board`, async () => {
        wizardState.startFlow("ha-hardware");
        const el = await fixture(
          html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`
        );
        await waitUntil(() => el.shadowRoot!.querySelector("device-card"));
        const group = el.shadowRoot!.querySelector("wa-radio-group")!;
        group.value = value;
        group.dispatchEvent(new Event("change"));
        const selections = wizardState.getState().selections;
        expect(selections.device).to.equal(value);
        expect(selections.haHardware).to.equal(id);
        expect(selections.deviceConfig!.board).to.equal(board);
        expect(selections.deviceCatalogReady).to.equal(true);
      });
    }

    it("only offers the Blue and the CM5 while the catalog lists their boards", async () => {
      wizardState.startFlow("ha-hardware");
      const manifest = deferred<typeof MOCK_MANIFEST>();
      mockTauriIpc(() => manifest.promise);
      const el = await fixture(
        html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`
      );
      manifest.resolve({ ...MOCK_MANIFEST, devices: [] });
      await waitUntil(() => el.shadowRoot!.querySelector("device-card"));
      const values = [...el.shadowRoot!.querySelectorAll("device-card")].map(
        (card) => card.value
      );
      expect(values).to.deep.equal(["ha-green", "ha-yellow-cm4"]);
    });

    it("forgets the drive when switching to another device", async () => {
      select("yellow-cm4", "Home Assistant Yellow with CM4");
      storeDriveSelection(MOCK_BLOCK_DEVICES[2]);
      const el = await fixture(
        html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`
      );
      await waitUntil(() => el.shadowRoot!.querySelector("device-card"));
      const group = el.shadowRoot!.querySelector("wa-radio-group")!;

      group.value = "ha-yellow-cm4";
      group.dispatchEvent(new Event("change"));
      expect(wizardState.getState().selections.drive).to.equal(
        MOCK_BLOCK_DEVICES[2].id
      );

      group.value = "ha-yellow-cm5";
      group.dispatchEvent(new Event("change"));
      expect(wizardState.getState().selections.drive).to.equal(undefined);
    });

    it("forgets the drive when the previous device was cleared", async () => {
      // A catalog refresh can drop the selected device but leave its drive
      select("blue", "Home Assistant Blue");
      storeDriveSelection(MOCK_BLOCK_DEVICES[2]);
      wizardState.setSelection("haHardware", undefined);
      const el = await fixture(
        html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`
      );
      await waitUntil(() => el.shadowRoot!.querySelector("device-card"));
      const group = el.shadowRoot!.querySelector("wa-radio-group")!;
      group.value = "ha-green";
      group.dispatchEvent(new Event("change"));
      expect(wizardState.getState().selections.drive).to.equal(undefined);
    });
  });

  it("accepts small drives for the installers only", () => {
    const smallCard = { ...MOCK_BLOCK_DEVICES[0], size: 2_000_000_000 };
    for (const hardware of HA_HARDWARE) {
      expect(isEligibleFlashTarget(smallCard, configFor(hardware.id))).to.equal(
        !!hardware.installer,
        hardware.id
      );
    }
  });

  describe("connect instructions", () => {
    for (const [id, expected] of [
      ["green", ["Connect a microSD card", "card reader"]],
      ["yellow-cm4", ["Connect a USB flash drive"]],
      [
        "yellow-cm5",
        [
          "Set jumper JP1 to USB",
          "recovery button",
          "bridge JP2",
          "Only the red LED",
          "sudo ./rpiboot -d mass-storage-gadget64",
          "rpiboot-CM4-CM5 - Mass Storage Gadget",
          "Rosetta",
          "RPi-MSD",
          "format the disk",
        ],
      ],
      [
        "blue",
        [
          "USB eMMC adapter",
          "No. 2 hex key",
          "from MMC to SPI",
          "micro-USB OTG",
          "Exit to shell",
          "ums /dev/mmcblk0",
        ],
      ],
    ] as const) {
      it(`explains how to connect ${id}`, async () => {
        const el = await fixture<HaHardwareConnectInstructions>(
          html`<ha-hardware-connect-instructions
            .hardware=${id}
          ></ha-hardware-connect-instructions>`
        );
        for (const part of expected) {
          expect(text(el.shadowRoot!)).to.contain(part);
        }
      });
    }

    it("puts commands in code and links rpiboot", async () => {
      const el = await fixture<HaHardwareConnectInstructions>(
        html`<ha-hardware-connect-instructions
          .hardware=${"yellow-cm5"}
        ></ha-hardware-connect-instructions>`
      );
      const code = [...el.shadowRoot!.querySelectorAll("code")].map(
        (node) => node.textContent
      );
      expect(code).to.include("sudo ./rpiboot -d mass-storage-gadget64");
      expect(el.shadowRoot!.querySelector("a")!.href).to.equal(
        "https://github.com/raspberrypi/usbboot"
      );
      expect(el.shadowRoot!.querySelector("ol")).to.exist;
    });

    it("renders nothing without a device", async () => {
      const el = await fixture<HaHardwareConnectInstructions>(
        html`<ha-hardware-connect-instructions></ha-hardware-connect-instructions>`
      );
      expect(el.shadowRoot!.querySelector(".instructions")).to.equal(null);
    });
  });

  it("drive step shows the instructions for the selected device", async () => {
    select("blue", "Home Assistant Blue");
    const el = await fixture(
      html`<drive-selection-view></drive-selection-view>`
    );
    const instructions = el.shadowRoot!.querySelector(
      "ha-hardware-connect-instructions"
    )!;
    expect(instructions.hardware).to.equal("blue");
    expect(text(el.shadowRoot!)).to.contain(
      "Connect the storage of your device"
    );
  });

  it("other flows do not get the instructions", async () => {
    wizardState.startFlow("sbc");
    const el = await fixture(
      html`<drive-selection-view></drive-selection-view>`
    );
    expect(el.shadowRoot!.querySelector("ha-hardware-connect-instructions")).to
      .not.exist;
  });

  describe("confirmation", () => {
    it("names the installer instead of looking up a release", async () => {
      select("green", "Home Assistant Green");
      let calls = 0;
      mockTauriIpc(() => {
        calls++;
        throw new Error("must not look up a release");
      });
      const el = await fixture(html`<confirmation-view></confirmation-view>`);
      const content = text(el.shadowRoot!);
      expect(content).to.contain("Green installer, April 10, 2024");
      expect(content).not.to.contain("green-installer");
      expect(el.shadowRoot!.querySelector(".notice")!.textContent).to.contain(
        "the installer reinstalls Home Assistant OS and erases all data"
      );
      expect(calls).to.equal(0);
    });

    it("shows the Yellow installer for a CM4", async () => {
      select("yellow-cm4", "Home Assistant Yellow with CM4");
      const el = await fixture(html`<confirmation-view></confirmation-view>`);
      expect(text(el.shadowRoot!)).to.contain(
        "Yellow installer, October 25, 2023"
      );
    });

    it("shows the HAOS release for a CM5", async () => {
      select("yellow-cm5", "Home Assistant Yellow with CM5");
      mockTauriIpc((command, args) => {
        expect(command).to.equal("get_haos_release");
        expect(args).to.have.property("board", "yellow");
        return { version: "18.2", images: [] };
      });
      const el = await fixture(html`<confirmation-view></confirmation-view>`);
      await waitUntil(() => text(el.shadowRoot!).includes("Version 18.2"));
      expect(text(el.shadowRoot!)).not.to.contain("installer");
      expect(el.shadowRoot!.querySelector(".notice")!.textContent).to.contain(
        "Home Assistant included"
      );
    });

    it("shows the HAOS release for the Blue", async () => {
      select("blue", "Home Assistant Blue");
      mockTauriIpc((command, args) => {
        expect(command).to.equal("get_haos_release");
        expect(args).to.have.property("board", "odroid-n2");
        return { version: "18.2", images: [] };
      });
      const el = await fixture(html`<confirmation-view></confirmation-view>`);
      await waitUntil(() => text(el.shadowRoot!).includes("Version 18.2"));
      expect(el.shadowRoot!.querySelector(".notice")!.textContent).to.contain(
        "Home Assistant included"
      );
    });

    it("keeps the SBC confirmation free of the notice", async () => {
      wizardState.startFlow("sbc");
      mockTauriIpc(() => ({ version: "18.2", images: [] }));
      wizardState.setSelection("deviceConfig", MOCK_MANIFEST.devices[0].haos);
      const el = await fixture(html`<confirmation-view></confirmation-view>`);
      expect(el.shadowRoot!.querySelector(".notice")).to.equal(null);
    });
  });

  it("flashes the installer board and says so", async () => {
    select("yellow-cm4", "Home Assistant Yellow with CM4");
    storeDriveSelection(MOCK_BLOCK_DEVICES[2]);
    const requests: FlashRequest[] = [];
    mockTauriIpc((command, args) => {
      expect(command).to.equal("flash_image");
      requests.push((args as { request: FlashRequest }).request);
      return new Promise(() => {});
    });
    const el = fixtureSync(html`<progress-view></progress-view>`);
    await waitUntil(() => requests.length === 1);
    expect(requests[0].board).to.equal("yellow-installer");
    expect(requests[0].device_id).to.equal(MOCK_BLOCK_DEVICES[2].id);
    const progress = el.shadowRoot!.querySelector("install-progress")!;
    expect(progress.description).to.equal("Fetching the installer image");
  });

  describe("success", () => {
    for (const [id, expected, guide] of [
      [
        "green",
        [
          "needs internet access",
          "Shut down system",
          "hold the power button for 6 seconds",
          "until it clicks",
          "yellow LED blinks fast",
          "heartbeat pattern",
        ],
        "https://support.nabucasa.com/hc/en-us/articles/25162566451485",
      ],
      [
        "yellow-cm4",
        [
          "Unplug every USB device",
          "Within 3 seconds",
          "red and blue buttons",
          "only works while Home Assistant OS is installed",
          "remove the USB flash drive",
        ],
        "https://support.nabucasa.com/hc/en-us/articles/25484982657309",
      ],
      [
        "yellow-cm5",
        [
          "Disconnect the USB-C cable",
          "JP1 back to UART",
          "starts Home Assistant OS from the eMMC",
        ],
        "https://support.nabucasa.com/hc/en-us/articles/25485061432093",
      ],
      [
        "blue",
        [
          "boot mode toggle back to MMC",
          "put the eMMC module back",
          "Preparing Home Assistant page",
        ],
        "https://www.home-assistant.io/installation/odroid",
      ],
    ] as const) {
      it(`gives the ${id} its own next steps`, async () => {
        select(id, "Unused");
        const el = await fixture(
          html`<ha-hardware-success-view></ha-hardware-success-view>`
        );
        const success = el.shadowRoot!.querySelector("install-success")!;
        await success.updateComplete;
        const content = text(success.shadowRoot!);
        for (const part of expected) {
          expect(content).to.contain(part);
        }
        expect(content).to.contain("homeassistant.local:8123");
        expect(
          success.shadowRoot!.querySelector<HTMLAnchorElement>(
            ".next-steps-footer a"
          )!.href
        ).to.equal(guide);
        // Only devices with a pinned installer get one written
        const installer = !!findHaHardware(id)!.installer;
        expect(content.includes("The installer has been written")).to.equal(
          installer
        );
        expect(content.includes("Home Assistant OS has been written")).to.equal(
          !installer
        );
      });
    }
  });
});
