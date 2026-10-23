import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import type { HaSetupStatus } from "../../../src/api/types.js";
import "../../../src/components/home-assistant-status.js";
import type { HomeAssistantStatus } from "../../../src/components/home-assistant-status.js";
import type { ProgressBar } from "../../../src/components/progress-bar.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import { mockTauriIpc, restoreTauriIpc } from "../tauri-ipc.js";

const MINUTE = 60 * 1000;

describe("home-assistant-status", () => {
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
   * A device that starts once the first lookups noted what was there, and
   * Home Assistant on it, answering as told
   */
  function device({
    updated = () => true,
    setup = () => null,
    onLookup = () => {},
  }: {
    updated?: () => boolean;
    setup?: () => HaSetupStatus | null;
    onLookup?: (lookup: number) => void;
  } = {}) {
    let lookups = 0;
    const opened: string[] = [];
    mockTauriIpc((cmd, args) => {
      switch (cmd) {
        case "find_home_assistants":
          onLookup(lookups);
          return lookups++ < 2
            ? []
            : [{ id: "device", address: "192.0.2.60", landing_page: true }];
        case "check_ha_ready":
          return true;
        case "check_ha_updated":
          return updated();
        case "get_ha_setup_status":
          return setup();
        case "plugin:opener|open_url":
          opened.push((args as { url: string }).url);
          return undefined;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    return { lookups: () => lookups, opened };
  }

  function render() {
    return fixture<HomeAssistantStatus>(
      html`<home-assistant-status></home-assistant-status>`
    );
  }

  const text = (el: HomeAssistantStatus) =>
    el.shadowRoot!.textContent!.replace(/\s+/g, " ");

  const currentStage = (el: HomeAssistantStatus) =>
    el
      .shadowRoot!.querySelector('[aria-current="step"] .stage-label')
      ?.textContent?.trim();

  const announced = (el: HomeAssistantStatus) =>
    el.shadowRoot!.querySelector('[role="status"]')!.textContent!.trim();

  it("looks for the device first, and says how to find it without that", async () => {
    device();
    const el = await render();

    expect(currentStage(el)).to.equal("Looking for your device on the network");
    expect(text(el)).to.contain(
      "Doesn't it show up? Open http://homeassistant.local"
    );
    // On show from the start, so there is nothing new to read out
    expect(announced(el)).to.equal("");
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
    const el = await render();

    await waitUntil(
      () => el.shadowRoot!.querySelector<ProgressBar>("progress-bar")?.progress,
      "the download never showed",
      { timeout: 4000 }
    );
    expect(currentStage(el)).to.equal("Installing latest Home Assistant");
    expect(
      el.shadowRoot!.querySelectorAll(".status-dot.completed")
    ).to.have.length(2);
    const bar = el.shadowRoot!.querySelector<ProgressBar>("progress-bar")!;
    expect(bar.progress).to.equal(42.4);
    expect(bar.indeterminate).to.be.false;
    expect(text(el)).to.contain("42%");
    // Worded for a device, not a VM
    expect(text(el)).to.contain("Install it on a larger drive.");
    expect(text(el)).to.contain("You can follow along at http://192.0.2.60");
    // The stage and what holds it up are read out, not every percent
    expect(announced(el)).to.equal(
      "Installing latest Home Assistant. Home Assistant is running out of disk space. Install it on a larger drive."
    );
  });

  it("links to Home Assistant once it's ready", async () => {
    const { opened } = device();
    const el = await render();

    await waitUntil(
      () => el.shadowRoot!.querySelector("wa-button"),
      "it never got ready",
      { timeout: 4000 }
    );
    expect(text(el)).to.contain("Your Home Assistant is ready");
    expect(announced(el)).to.equal("Your Home Assistant is ready");
    expect(
      el.shadowRoot!.querySelectorAll(".status-dot.completed")
    ).to.have.length(3);
    const open = el.shadowRoot!.querySelector("wa-button")!;
    expect(open.getAttribute("href")).to.equal("http://192.0.2.60");
    expect(open.textContent).to.contain("Opens in your browser.");
    open.click();
    await waitUntil(() => opened.length);
    expect(opened).to.deep.equal(["http://192.0.2.60"]);
  });

  it("says when the device didn't show up, and looks on when asked", async () => {
    // The first lookup takes past the deadline
    const { lookups } = device({
      onLookup: (lookup) => {
        if (lookup === 0) clockOffset += 31 * MINUTE;
      },
    });
    const el = await render();

    await waitUntil(() => text(el).includes("Your device didn't show up"));
    expect(text(el)).to.contain(
      "Nothing new appeared on your network within 30 minutes"
    );
    expect(text(el)).to.contain("Doesn't it show up?");
    expect(announced(el)).to.equal("Your device didn't show up");
    expect(lookups()).to.equal(2);

    el.shadowRoot!.querySelector<HTMLElement>("wa-button")!.click();
    await waitUntil(() => text(el).includes("Your Home Assistant is ready"));
    // It still knows what was there before: the next lookup finds the device
    expect(lookups()).to.equal(3);
  });

  it("stops looking once it leaves the page", async () => {
    const { lookups } = device();
    const el = await render();

    await waitUntil(() => lookups() === 2);
    el.remove();
    // Past the next lookup's time
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(lookups()).to.equal(2);
  });
});
