import {
  expect,
  fixture,
  fixtureCleanup,
  fixtureSync,
  html,
  waitUntil,
} from "@open-wc/testing";
import "../../../../src/views/ha-hardware/device-selection-view.js";
import "../../../../src/views/ha-hardware/module-selection-view.js";
import "../../../../src/views/ha-hardware/connect-instructions.js";
import "../../../../src/views/ha-hardware/success-view.js";
import "../../../../src/views/sbc/confirmation-view.js";
import "../../../../src/views/sbc/drive-selection-view.js";
import "../../../../src/views/sbc/progress-view.js";
import type { HaHardwareDeviceSelectionView } from "../../../../src/views/ha-hardware/device-selection-view.js";
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
import { wizardStep } from "../../../../src/components/wizard-steps.js";
import {
  isEligibleFlashTarget,
  storeDriveSelection,
} from "../../../../src/utils/drive-selection.js";
import { deferred, mockTauriIpc, restoreTauriIpc } from "../../tauri-ipc.js";
import { expectThemeLink } from "../../helpers/link-style.js";

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
    it("offers the Green, one Yellow and the Blue", async () => {
      wizardState.startFlow("ha-hardware");
      const el = await fixture(
        html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`
      );
      await waitUntil(() => el.shadowRoot!.querySelector("device-card"));
      const cards = [...el.shadowRoot!.querySelectorAll("device-card")];
      expect(cards.map((card) => card.value)).to.deep.equal([
        "ha-green",
        "ha-yellow",
        "ha-blue",
      ]);
      expect(cards.map((card) => card.name)).to.deep.equal([
        "Home Assistant Green",
        "Home Assistant Yellow",
        "Home Assistant Blue",
      ]);
    });

    for (const [id, name, heading, action, note] of [
      [
        "green",
        "Home Assistant Green",
        "Your Home Assistant Green is ready to use",
        "Reinstall",
        "Only reinstall to reset or recover it",
      ],
      [
        "blue",
        "Home Assistant Blue",
        "Your Home Assistant Blue is ready to use",
        "Reinstall",
        "Only reinstall to reset or recover it",
      ],
      [
        "yellow-cm4",
        "Home Assistant Yellow with CM4",
        "Your Yellow may be ready to use",
        "Install",
        "set up a compute module of your own",
      ],
    ] as const) {
      it(`asks before reinstalling the ${id}`, async () => {
        select(id, name);
        const el = await fixture<HaHardwareDeviceSelectionView>(
          html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`
        );
        await waitUntil(() => el.shadowRoot!.querySelector("device-card"));
        const dialog = el.shadowRoot!.querySelector("info-dialog")!;
        expect(dialog.open).to.equal(false);

        const declined = el.confirmReinstall();
        await el.updateComplete;
        expect(dialog.open).to.equal(true);
        expect(dialog.heading).to.equal(heading);
        expect(dialog.message).to.contain("homeassistant.local");
        expect(dialog.primaryLabel).to.equal(action);
        expect(dialog.textContent).to.contain(note);
        dialog.dispatchEvent(new CustomEvent("dialog-secondary"));
        expect(await declined).to.equal(false);

        const confirmed = el.confirmReinstall();
        await el.updateComplete;
        dialog.dispatchEvent(new CustomEvent("dialog-primary"));
        expect(await confirmed).to.equal(true);
        await el.updateComplete;
        expect(dialog.open).to.equal(false);
      });
    }

    it("declines the reinstall question when the step goes away", async () => {
      select("green", "Home Assistant Green");
      const el = await fixture<HaHardwareDeviceSelectionView>(
        html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`
      );
      await waitUntil(() => el.shadowRoot!.querySelector("device-card"));
      const answer = el.confirmReinstall();
      el.remove();
      expect(await answer).to.equal(false);
    });

    for (const [value, id, board] of [
      ["ha-green", "green", "green-installer"],
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
        expect(
          wizardState.getState().steps.map((step) => step.id)
        ).not.to.include("module");
      });
    }

    it("selecting the Yellow leaves its compute module to the next step", async () => {
      wizardState.startFlow("ha-hardware");
      const el = await fixture(
        html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`
      );
      await waitUntil(() => el.shadowRoot!.querySelector("device-card"));
      const group = el.shadowRoot!.querySelector("wa-radio-group")!;
      group.value = "ha-yellow";
      group.dispatchEvent(new Event("change"));
      const { selections, steps } = wizardState.getState();
      expect(selections.device).to.equal("ha-yellow");
      expect(selections.deviceName).to.equal("Home Assistant Yellow");
      expect(selections.haHardware).to.equal(undefined);
      expect(selections.deviceConfig).to.equal(undefined);
      expect(selections.yellowModules!.map(({ id }) => id)).to.deep.equal([
        "yellow-cm4",
        "yellow-cm5",
      ]);
      expect(steps.map((step) => step.id).slice(0, 3)).to.deep.equal([
        "device",
        "module",
        "drive",
      ]);
    });

    it("keeps the compute module when the Yellow is picked again", async () => {
      select("yellow-cm5", "Home Assistant Yellow with CM5");
      storeDriveSelection(MOCK_BLOCK_DEVICES[2]);
      const el = await fixture(
        html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`
      );
      await waitUntil(() => el.shadowRoot!.querySelector("device-card"));
      const group = el.shadowRoot!.querySelector("wa-radio-group")!;
      group.value = "ha-yellow";
      group.dispatchEvent(new Event("change"));
      const { selections } = wizardState.getState();
      expect(selections.haHardware).to.equal("yellow-cm5");
      expect(selections.deviceName).to.equal("Home Assistant Yellow with CM5");
      expect(selections.drive).to.equal(MOCK_BLOCK_DEVICES[2].id);
    });

    it("asks for the compute module again after another device", async () => {
      select("yellow-cm5", "Home Assistant Yellow with CM5");
      const el = await fixture(
        html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`
      );
      await waitUntil(() => el.shadowRoot!.querySelector("device-card"));
      const group = el.shadowRoot!.querySelector("wa-radio-group")!;
      group.value = "ha-green";
      group.dispatchEvent(new Event("change"));
      expect(
        wizardState.getState().steps.map((step) => step.id)
      ).not.to.include("module");

      group.value = "ha-yellow";
      group.dispatchEvent(new Event("change"));
      const { selections, steps } = wizardState.getState();
      expect(selections.haHardware).to.equal(undefined);
      expect(selections.deviceName).to.equal("Home Assistant Yellow");
      expect(selections.deviceConfig).to.equal(undefined);
      expect(steps.map((step) => step.id)).to.include("module");
      expect(wizardStep("ha-hardware", "module")!.ready!(selections)).to.equal(
        false
      );
    });

    it("hands on the compute modules again when the catalog reloads", async () => {
      // Back from the module step reloads the catalog, which may have changed
      select("yellow-cm4", "Home Assistant Yellow with CM4");
      wizardState.setSelection("yellowModules", []);
      const el = await fixture(
        html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`
      );
      await waitUntil(() => el.shadowRoot!.querySelector("device-card"));
      expect(
        wizardState.getState().selections.yellowModules!.map(({ id }) => id)
      ).to.deep.equal(["yellow-cm4", "yellow-cm5"]);
    });

    it("leaves out the Blue and the CM5 when the catalog lacks their boards", async () => {
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
      expect(values).to.deep.equal(["ha-green", "ha-yellow"]);
      const group = el.shadowRoot!.querySelector("wa-radio-group")!;
      group.value = "ha-yellow";
      group.dispatchEvent(new Event("change"));
      expect(
        wizardState.getState().selections.yellowModules!.map(({ id }) => id)
      ).to.deep.equal(["yellow-cm4"]);
    });

    it("forgets the drive when switching to another device", async () => {
      select("yellow-cm4", "Home Assistant Yellow with CM4");
      storeDriveSelection(MOCK_BLOCK_DEVICES[2]);
      const el = await fixture(
        html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`
      );
      await waitUntil(() => el.shadowRoot!.querySelector("device-card"));
      const group = el.shadowRoot!.querySelector("wa-radio-group")!;

      group.value = "ha-yellow";
      group.dispatchEvent(new Event("change"));
      expect(wizardState.getState().selections.drive).to.equal(
        MOCK_BLOCK_DEVICES[2].id
      );

      group.value = "ha-green";
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

  describe("compute module selection", () => {
    /** Selections as the device step leaves them for the Yellow. */
    function pickYellow() {
      wizardState.startFlow("ha-hardware");
      wizardState.setSelection("device", "ha-yellow");
      wizardState.setSelection("deviceName", "Home Assistant Yellow");
      wizardState.setSelection("yellowModules", [
        { id: "yellow-cm4", config: configFor("yellow-cm4") },
        { id: "yellow-cm5", config: configFor("yellow-cm5") },
      ]);
    }

    it("offers the compute modules the device step handed on", async () => {
      pickYellow();
      const el = await fixture(
        html`<ha-hardware-module-selection-view></ha-hardware-module-selection-view>`
      );
      const radios = [...el.shadowRoot!.querySelectorAll("wa-radio")];
      expect(radios.map((radio) => radio.value)).to.deep.equal([
        "yellow-cm4",
        "yellow-cm5",
      ]);
      expect(text(el.shadowRoot!)).to.contain("Compute Module 4");
      expect(text(el.shadowRoot!)).to.contain("Compute Module 5");
      expect(text(el.shadowRoot!)).to.contain("4 or 5 inside");
    });

    for (const [id, name, board] of [
      ["yellow-cm4", "Home Assistant Yellow with CM4", "yellow-installer"],
      // The installer only boots on a CM4; a CM5 gets Home Assistant OS
      ["yellow-cm5", "Home Assistant Yellow with CM5", "yellow"],
    ] as const) {
      it(`selecting ${id} stores the ${board} board`, async () => {
        pickYellow();
        const el = await fixture(
          html`<ha-hardware-module-selection-view></ha-hardware-module-selection-view>`
        );
        const group = el.shadowRoot!.querySelector("wa-radio-group")!;
        group.value = id;
        group.dispatchEvent(new Event("change"));
        const selections = wizardState.getState().selections;
        expect(selections.device).to.equal("ha-yellow");
        expect(selections.haHardware).to.equal(id);
        expect(selections.deviceName).to.equal(name);
        expect(selections.deviceConfig!.board).to.equal(board);
      });
    }

    it("marks the chosen compute module with a check, not only a color", async () => {
      pickYellow();
      const el = await fixture(
        html`<ha-hardware-module-selection-view></ha-hardware-module-selection-view>`
      );
      const radios = [...el.shadowRoot!.querySelectorAll("wa-radio")];
      const checks = () =>
        radios.map((radio) => !!radio.querySelector(".selected-indicator"));
      expect(checks()).to.deep.equal([false, false]);

      radios[1].click();
      await waitUntil(() => checks()[1], "choice never marked");
      expect(checks()).to.deep.equal([false, true]);
      const check = radios[1].querySelector(".selected-indicator")!;
      expect(check.getAttribute("aria-hidden")).to.equal("true");
      // The check sits in the radio's corner, out of the centered content
      const radioBox = radios[1].getBoundingClientRect();
      const checkBox = check.getBoundingClientRect();
      expect(checkBox.width).to.be.greaterThan(0);
      expect(radioBox.right - checkBox.right).to.be.within(8, 10);
      expect(checkBox.top - radioBox.top).to.be.within(8, 10);

      radios[0].click();
      await waitUntil(() => checks()[0], "new choice never marked");
      expect(checks()).to.deep.equal([true, false]);
    });

    it("forgets the drive when switching to another compute module", async () => {
      pickYellow();
      const el = await fixture(
        html`<ha-hardware-module-selection-view></ha-hardware-module-selection-view>`
      );
      const group = el.shadowRoot!.querySelector("wa-radio-group")!;
      group.value = "yellow-cm4";
      group.dispatchEvent(new Event("change"));
      storeDriveSelection(MOCK_BLOCK_DEVICES[2]);

      group.value = "yellow-cm4";
      group.dispatchEvent(new Event("change"));
      expect(wizardState.getState().selections.drive).to.equal(
        MOCK_BLOCK_DEVICES[2].id
      );

      group.value = "yellow-cm5";
      group.dispatchEvent(new Event("change"));
      expect(wizardState.getState().selections.drive).to.equal(undefined);
    });

    it("takes the compute module's storage from the reloaded catalog", async () => {
      // Back on the device step, the catalog reloaded and changed the CM5's
      pickYellow();
      wizardState.setSelection("haHardware", "yellow-cm5");
      wizardState.setSelection("deviceConfig", configFor("yellow-cm5"));
      const reloaded = {
        ...configFor("yellow-cm5"),
        minimum_storage_bytes: 64_000_000_000,
      };
      wizardState.setSelection("yellowModules", [
        { id: "yellow-cm4", config: configFor("yellow-cm4") },
        { id: "yellow-cm5", config: reloaded },
      ]);
      const el = await fixture(
        html`<ha-hardware-module-selection-view></ha-hardware-module-selection-view>`
      );
      expect(el.shadowRoot!.querySelector("wa-radio-group")!.value).to.equal(
        "yellow-cm5"
      );
      expect(wizardState.getState().selections.deviceConfig).to.equal(reloaded);
    });

    it("drops a compute module the catalog no longer offers", async () => {
      pickYellow();
      wizardState.setSelection("haHardware", "yellow-cm5");
      wizardState.setSelection("deviceConfig", configFor("yellow-cm5"));
      wizardState.setSelection("yellowModules", [
        { id: "yellow-cm4", config: configFor("yellow-cm4") },
      ]);
      await fixture(
        html`<ha-hardware-module-selection-view></ha-hardware-module-selection-view>`
      );
      const selections = wizardState.getState().selections;
      expect(selections.haHardware).to.equal(undefined);
      expect(selections.deviceConfig).to.equal(undefined);
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
    // The stub shadows the prototype getter; deleting it restores the real UA.
    afterEach(() => {
      delete (window.navigator as { userAgent?: string }).userAgent;
    });

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
          "remove the JP2 bridge",
          "RPi-MSD",
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

    for (const [platform, userAgent, code, shown, hidden] of [
      [
        "macos",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        "sudo ./rpiboot -d mass-storage-gadget64",
        ["In Terminal", "Rosetta", "choose Ignore"],
        ["Start menu", "format"],
      ],
      [
        "linux",
        "Mozilla/5.0 (X11; Linux x86_64)",
        "sudo ./rpiboot -d mass-storage-gadget64",
        ["In a terminal"],
        ["Rosetta", "Start menu", "Ignore", "format"],
      ],
      [
        "windows",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "rpiboot-CM4-CM5 - Mass Storage Gadget",
        ["Install rpiboot", "Start menu", "choose Cancel"],
        ["sudo", "Rosetta", "Ignore"],
      ],
    ] as const) {
      it(`tells ${platform} users how to run rpiboot`, async () => {
        Object.defineProperty(window.navigator, "userAgent", {
          value: userAgent,
          configurable: true,
        });
        const el = await fixture<HaHardwareConnectInstructions>(
          html`<ha-hardware-connect-instructions
            .hardware=${"yellow-cm5"}
          ></ha-hardware-connect-instructions>`
        );
        const codes = [...el.shadowRoot!.querySelectorAll("code")].map(
          (node) => node.textContent
        );
        expect(codes).to.include(code);
        for (const part of shown) {
          expect(text(el.shadowRoot!)).to.contain(part);
        }
        for (const part of hidden) {
          expect(text(el.shadowRoot!)).not.to.contain(part);
        }
      });
    }

    it("links rpiboot", async () => {
      const el = await fixture<HaHardwareConnectInstructions>(
        html`<ha-hardware-connect-instructions
          .hardware=${"yellow-cm5"}
        ></ha-hardware-connect-instructions>`
      );
      expect(el.shadowRoot!.querySelector("a")!.href).to.equal(
        "https://github.com/raspberrypi/usbboot"
      );
      expectThemeLink(el.shadowRoot!.querySelector("a")!);
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
      expect(
        el.shadowRoot!.querySelector("inline-notice")!.textContent
      ).to.contain(
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
      expect(
        el.shadowRoot!.querySelector("inline-notice")!.textContent
      ).to.contain("Home Assistant included");
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
      expect(
        el.shadowRoot!.querySelector("inline-notice")!.textContent
      ).to.contain("Home Assistant included");
    });

    it("keeps the SBC confirmation free of the notice", async () => {
      wizardState.startFlow("sbc");
      mockTauriIpc(() => ({ version: "18.2", images: [] }));
      wizardState.setSelection("deviceConfig", MOCK_MANIFEST.devices[0].haos);
      const el = await fixture(html`<confirmation-view></confirmation-view>`);
      expect(el.shadowRoot!.querySelector("inline-notice")).to.equal(null);
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
          "blinks fast while it writes",
          "When only the red LED is on",
          "remove the USB flash drive",
          "connect power again",
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
        expect(content).to.contain("homeassistant.local");
        expect(content).not.to.contain(":8123");
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
