import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import type { WizardFlow } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/sbc/success-view.js";
import type { SuccessView } from "../../../../src/views/sbc/success-view.js";
import { mockTauriIpc, restoreTauriIpc, settle } from "../../tauri-ipc.js";

async function renderSuccess(board = "rpi5-64", flow: WizardFlow = "sbc") {
  wizardState.startFlow(flow);
  wizardState.setSelection("deviceName", "Selected device");
  wizardState.setSelection("deviceConfig", {
    board,
    minimum_storage_bytes: 16_000_000_000,
    recommended_storage_bytes: 32_000_000_000,
  });
  const el = await fixture<SuccessView>(html`<success-view></success-view>`);
  await el.shadowRoot!.querySelector("install-success")!.updateComplete;
  return el;
}

/** The shared success layout renders the guidance in its own shadow root. */
function content(el: SuccessView) {
  return el.shadowRoot!.querySelector("install-success")!.shadowRoot!;
}

function text(el: SuccessView) {
  return content(el).textContent!.replace(/\s+/g, " ");
}

describe("success-view next steps", () => {
  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  it("distinguishes written storage from first-boot preparation", async () => {
    const el = await renderSuccess();
    expect(text(el)).to.contain("Home Assistant OS has been written");
    expect(text(el)).to.contain(
      "Insert the written storage into Selected device"
    );
    expect(text(el)).to.contain("Ethernet cable to the same network");
    expect(text(el)).to.contain("with internet access");
    expect(text(el)).to.contain("Then connect power");
    expect(text(el)).to.contain("Once the device is on, select Next");
    expect(text(el)).to.contain("installs the latest Home Assistant");
    expect(text(el)).to.contain("about 20 minutes");
    expect(text(el)).to.contain("Keep power and Ethernet connected");
    expect(text(el)).not.to.contain("Wait a few minutes");
  });

  it("names the Wi-Fi network instead of asking for a cable", async () => {
    const el = await renderSuccess();
    wizardState.setSelection("wifi", { ssid: "Home", password: "" });
    await el.updateComplete;
    await el.shadowRoot!.querySelector("install-success")!.updateComplete;
    expect(text(el)).to.contain("joins the Wi-Fi network Home");
    expect(text(el)).not.to.contain("Ethernet cable to the same network");
    expect(text(el)).not.to.contain("Keep power and Ethernet connected");
  });

  it("says how to start the device, and leaves the rest to the next steps", async () => {
    const lookups: string[] = [];
    mockTauriIpc((cmd) => {
      lookups.push(cmd);
      return [];
    });
    const el = await renderSuccess();
    // Home Assistant isn't there yet: the steps after this one find it
    expect(text(el)).to.contain("Almost there!");
    expect(text(el)).not.to.contain("You're all set!");
    expect(content(el).querySelector(".step-text a")).to.be.null;
    expect(text(el)).not.to.contain("Companion App");
    // Meanwhile, it notes what is on the network before the device starts
    await waitUntil(() => lookups.length === 2);
    expect(lookups).to.deep.equal([
      "find_home_assistants",
      "find_home_assistants",
    ]);
  });

  it("asks for manual ejection without claiming native ejection succeeded", async () => {
    const el = await renderSuccess();
    expect(text(el)).to.contain("If your computer still shows the drive");
    expect(text(el)).to.contain("eject it before you disconnect it");
    expect(text(el)).not.to.contain("safely ejected");
    const success = el.shadowRoot!.querySelector("install-success")!;
    expect(success.formatWarning).to.equal(true);
  });

  for (const board of ["odroid-n2", "odroid-m1s"]) {
    it(`covers both storage-adapter and direct-USB installation for ${board}`, async () => {
      const el = await renderSuccess(board);
      expect(text(el)).to.contain("If you used a storage adapter");
      expect(text(el)).to.contain("flashed the board directly over USB");
      expect(text(el)).to.contain("disconnect the USB and power cables");
      expect(text(el)).to.contain("With the board powered off");
      if (board === "odroid-m1s") {
        expect(text(el)).to.contain(
          "With the board powered off, remove the EMMC2UMS SD card if you used one."
        );
        expect(text(el)).not.to.contain("boot mode switch");
      } else {
        expect(text(el)).to.contain("set the boot mode switch back to MMC");
        expect(text(el)).not.to.contain("remove the EMMC2UMS SD card");
      }
    });
  }

  for (const board of ["generic-x86-64", "generic-aarch64"]) {
    it(`uses boot-drive and firmware guidance for ${board}`, async () => {
      const el = await renderSuccess(board, "minipc");
      expect(text(el)).to.contain(
        "Install or reconnect the written drive in your mini PC"
      );
      expect(text(el)).to.contain("firmware boot order");
      expect(text(el)).to.contain("UEFI boot enabled and Secure Boot disabled");
      expect(text(el)).not.to.contain("Insert the written storage into");
      expect(text(el)).not.to.contain("flashed the board directly over USB");
    });
  }

  for (const [board, url] of [
    ["rpi3-64", "https://www.home-assistant.io/installation/raspberrypi/"],
    ["rpi4-64", "https://www.home-assistant.io/installation/raspberrypi/"],
    ["rpi5-64", "https://www.home-assistant.io/installation/raspberrypi/"],
    ["odroid-c2", "https://www.home-assistant.io/installation/odroid/"],
    ["odroid-c4", "https://www.home-assistant.io/installation/odroid/"],
    ["odroid-m1", "https://www.home-assistant.io/installation/odroid/"],
    [
      "odroid-n2",
      "https://www.home-assistant.io/installation/odroid/#flashing-an-odroid-n2",
    ],
    [
      "odroid-m1s",
      "https://www.home-assistant.io/installation/odroid/#flashing-an-odroid-m1s",
    ],
    [
      "generic-x86-64",
      "https://www.home-assistant.io/installation/generic-x86-64/",
    ],
    [
      "generic-aarch64",
      "https://contributors.home-assistant.io/os/operating-system/generic/",
    ],
    ["khadas-vim3", "https://www.home-assistant.io/installation/"],
    ["unknown", "https://www.home-assistant.io/installation/"],
    ["constructor", "https://www.home-assistant.io/installation/"],
    [
      "https://untrusted.invalid/",
      "https://www.home-assistant.io/installation/",
    ],
  ]) {
    it(`links ${board} to a fixed installation guide`, async () => {
      const el = await renderSuccess(board);
      const link = content(el).querySelector<HTMLAnchorElement>(
        ".next-steps-footer a"
      )!;
      expect(link.href).to.equal(url);
      expect(link.target).to.equal("_blank");
      expect(link.rel).to.equal("noopener noreferrer");
    });
  }

  it("opens the selected guide using the existing external-link helper", async () => {
    const calls: unknown[] = [];
    mockTauriIpc((command, args) => {
      expect(command).to.equal("plugin:opener|open_url");
      calls.push(args);
    });
    const el = await renderSuccess();
    content(el)
      .querySelector<HTMLAnchorElement>(".next-steps-footer a")!
      .click();
    await settle();
    expect(calls).to.deep.equal([
      {
        url: "https://www.home-assistant.io/installation/raspberrypi/",
        with: undefined,
      },
    ]);
  });
});
