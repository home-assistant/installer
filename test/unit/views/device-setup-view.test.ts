import { expect, fixture, html, oneEvent, waitUntil } from "@open-wc/testing";
import type { HaSetupStatus } from "../../../src/api/types.js";
import type { InstallProgress } from "../../../src/components/install-progress.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import { flowDeviceFinder } from "../../../src/utils/device-discovery.js";
import "../../../src/views/device-setup-view.js";
import type { DeviceSetupView } from "../../../src/views/device-setup-view.js";
import { mockTauriIpc, restoreTauriIpc } from "../tauri-ipc.js";

const MINUTE = 60 * 1000;

describe("device-setup-view", () => {
  const realNow = Date.now;
  let clockOffset = 0;

  beforeEach(() => {
    wizardState.startFlow("sbc");
    clockOffset = 0;
    Date.now = () => realNow.call(Date) + clockOffset;
  });

  afterEach(() => {
    Date.now = realNow;
    restoreTauriIpc();
    wizardState.reset();
  });

  /**
   * A device that starts once the first two lookups noted what was there,
   * and Home Assistant on it, answering as told
   */
  function device({
    starts = true,
    updated = () => true,
    setup = () => null,
    onLookup = () => {},
  }: {
    starts?: boolean;
    updated?: () => boolean;
    setup?: () => HaSetupStatus | null;
    onLookup?: (lookup: number) => void;
  } = {}) {
    let lookups = 0;
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "find_home_assistants":
          onLookup(lookups);
          return lookups++ < 2 || !starts
            ? []
            : [{ id: "device", address: "192.0.2.60", landing_page: true }];
        case "check_ha_ready":
          return true;
        case "check_ha_updated":
          return updated();
        case "get_ha_setup_status":
          return setup();
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    return { lookups: () => lookups };
  }

  /** What the step before noted while it was shown */
  async function noted() {
    await flowDeviceFinder().survey(new AbortController().signal);
  }

  async function render() {
    const view = await fixture<DeviceSetupView>(
      html`<device-setup-view></device-setup-view>`
    );
    const progress =
      view.shadowRoot!.querySelector<InstallProgress>("install-progress")!;
    return { view, progress };
  }

  /** The help below the progress, its whitespace collapsed */
  function helpText(view: DeviceSetupView) {
    const help = view.shadowRoot!.querySelector('.help[slot="help"]')!;
    return help.textContent!.replace(/\s+/g, " ");
  }

  it("looks for the device, saying only how long that usually takes", async () => {
    device({ starts: false });
    const { view, progress } = await render();

    expect(progress.stage).to.equal("waiting");
    expect(progress.description).to.equal(
      "Looking for your device on the network"
    );
    expect(progress.stages.map(({ label }) => label)).to.deep.equal([
      "Looking for your device on the network",
      "Waiting for Home Assistant",
      "Installing latest Home Assistant",
    ]);
    // Leaving loses nothing: the device carries on without the installer
    expect(progress.leavable).to.be.true;
    expect(helpText(view).trim()).to.equal(
      "This usually takes a few minutes after you turn the device on."
    );
  });

  it("says what to check once looking takes longer than usual", async () => {
    device({
      starts: false,
      onLookup: (lookup) => {
        if (lookup === 0) clockOffset += 6 * MINUTE;
      },
    });
    const { view } = await render();

    // Seen at the next lookup
    await waitUntil(
      () => helpText(view).includes("This is taking longer than usual."),
      "it never said so",
      { timeout: 3000 }
    );
    expect(helpText(view)).to.contain(
      "Check that the device is on and connected to your network."
    );
    expect(helpText(view)).to.contain(
      "Make sure this computer is on the same network, not a guest network or VPN."
    );
    expect(helpText(view)).to.contain(
      "Try opening homeassistant.local in your browser."
    );
    expect(
      view.shadowRoot!.querySelector<HTMLAnchorElement>(".help a")!.href
    ).to.equal("http://homeassistant.local/");
    // The IP address only for who asks for it
    const details = view.shadowRoot!.querySelector(".help wa-details")!;
    expect(details.getAttribute("summary")).to.equal(
      "Other ways to find your device"
    );
    expect(details.hasAttribute("open")).to.be.false;
    expect(details.textContent!.replace(/\s+/g, " ")).to.contain(
      "then open http://<IP address>."
    );
  });

  it("shows what the landing page reports while Home Assistant installs", async () => {
    device({
      updated: () => false,
      setup: () => ({
        core_install_progress: 42.4,
        supervisor_update_progress: null,
        problems: ["free_space"],
      }),
    });
    await noted();
    const { view, progress } = await render();

    await waitUntil(() => progress.measurable, "the download never showed");
    expect(progress.stage).to.equal("updating");
    expect(progress.progress).to.equal(42);
    expect(progress.indeterminate).to.be.false;
    // Worded for a device, not a VM
    expect(progress.warning).to.contain("Install it on a larger drive.");
    expect(progress.address).to.equal("http://192.0.2.60");
    // Found, so no need to say how to find it
    expect(view.shadowRoot!.querySelector('[slot="help"]')).to.be.null;
  });

  it("moves on to where to find Home Assistant once it's ready", async () => {
    device();
    await noted();
    const view = document.createElement("device-setup-view");
    const next = oneEvent(view, "wizard-next");
    document.body.append(view);
    try {
      await next;
      const { selections } = wizardState.getState();
      expect(selections.ipAddress).to.equal("192.0.2.60");
      expect(selections.homeAssistantReady).to.be.true;
    } finally {
      view.remove();
    }
  });

  it("says when the device didn't show up, and looks on when asked", async () => {
    // The lookups that note what is there take past the deadline
    const { lookups } = device({
      onLookup: (lookup) => {
        if (lookup === 1) clockOffset += 31 * MINUTE;
      },
    });
    const { view, progress } = await render();

    await waitUntil(() => progress.error, "it never gave up");
    expect(progress.errorHeading).to.equal("Your device didn't show up");
    expect(progress.error).to.equal(
      "Nothing new appeared on your network within 30 minutes."
    );
    // What to check, with every way to find it, as the error says enough
    // about it taking long
    expect(helpText(view)).to.contain(
      "Check that the device is on and connected to your network."
    );
    expect(helpText(view)).not.to.contain("taking longer");
    expect(
      view.shadowRoot!.querySelector(".help wa-details")!.hasAttribute("open")
    ).to.be.true;
    expect(lookups()).to.equal(2);

    const next = oneEvent(view, "wizard-next");
    view.shadowRoot!.querySelector<HTMLElement>("wa-button")!.click();
    // It still knows what was there before: the next lookup finds the device
    await next;
    expect(lookups()).to.equal(3);
  });

  it("stops looking once it leaves the page", async () => {
    const { lookups } = device();
    const { view } = await render();

    await waitUntil(() => lookups() === 2);
    view.remove();
    // Past the next lookup's time
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(lookups()).to.equal(2);
  });
});
