import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import { LitElement } from "lit";
import type { HaAnnouncement } from "../../../src/api/types.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import {
  DeviceFinder,
  DeviceSurvey,
  flowDeviceFinder,
} from "../../../src/utils/device-discovery.js";
import type { InstallerError } from "../../../src/utils/installer-error.js";
import { isCancelled } from "../../../src/utils/polling.js";
import {
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../tauri-ipc.js";

const landingPage = (id: string, address = "192.0.2.50"): HaAnnouncement => ({
  id,
  address,
  landing_page: true,
});

const homeAssistant = (id: string): HaAnnouncement => ({
  id,
  address: "192.0.2.10:8123",
  landing_page: false,
});

/** Answer the lookups in turn, the last one again once they run out */
function answer(
  ...lookups: (HaAnnouncement[] | InstallerError)[]
): () => number {
  let asked = 0;
  mockTauriIpc((cmd) => {
    expect(cmd).to.equal("find_home_assistants");
    const lookup = lookups[Math.min(asked++, lookups.length - 1)];
    return Array.isArray(lookup) ? lookup : Promise.reject(lookup);
  });
  return () => asked;
}

/** A step that notes what is on the network, as the start step does */
class SurveyingStep extends LitElement {
  protected readonly _survey = new DeviceSurvey(this);
}
customElements.define("test-surveying-step", SurveyingStep);

describe("device-discovery", () => {
  const signal = new AbortController().signal;

  afterEach(() => {
    restoreTauriIpc();
    wizardState.reset();
  });

  it("notes what is there first, then finds a landing page that wasn't", async () => {
    const asked = answer(
      [homeAssistant("existing")],
      // Answered only the second time, as a slow responder can
      [homeAssistant("existing"), landingPage("being-set-up")],
      [
        homeAssistant("existing"),
        landingPage("being-set-up"),
        landingPage("device", "192.0.2.60"),
      ]
    );
    const finder = new DeviceFinder();

    expect(await finder.find(signal)).to.be.null;
    expect(asked()).to.equal(2);
    expect(await finder.find(signal)).to.equal("192.0.2.60");
  });

  it("checks on the device where it was found once, without looking again", async () => {
    // Home Assistant has replaced the landing page by the time it is asked
    const asked = answer(
      [],
      [],
      [landingPage("device")],
      [homeAssistant("new")]
    );
    const finder = new DeviceFinder();

    expect(await finder.find(signal)).to.be.null;
    expect(await finder.find(signal)).to.equal("192.0.2.50");
    expect(await finder.find(signal)).to.equal("192.0.2.50");
    expect(asked()).to.equal(3);
  });

  it("never takes Home Assistant itself for the device", async () => {
    // One that was off while the first lookups ran
    answer([], [], [homeAssistant("back-on")]);
    const finder = new DeviceFinder();

    expect(await finder.find(signal)).to.be.null;
    expect(await finder.find(signal)).to.be.null;
  });

  it("asks again after a lookup that failed", async () => {
    const asked = answer(
      ipcError("io", "No network"),
      [landingPage("being-set-up")],
      [landingPage("being-set-up")],
      [landingPage("being-set-up"), landingPage("device")]
    );
    const finder = new DeviceFinder();

    let caught: unknown;
    await finder.find(signal).catch((error: unknown) => (caught = error));
    expect(caught).to.deep.include({ code: "io" });
    expect(await finder.find(signal)).to.be.null;
    expect(asked()).to.equal(3);
    expect(await finder.find(signal)).to.equal("192.0.2.50");
  });

  describe("after its first minute", () => {
    const realNow = Date.now;
    let clockOffset = 0;

    beforeEach(() => {
      clockOffset = 0;
      Date.now = () => realNow.call(Date) + clockOffset;
    });

    afterEach(() => {
      Date.now = realNow;
    });

    it("follows a device that started before any lookup answered", async () => {
      let answering = false;
      mockTauriIpc(() =>
        answering
          ? [landingPage("device")]
          : Promise.reject(ipcError("io", "No network"))
      );
      const finder = new DeviceFinder();

      await finder.find(signal).catch(() => {});
      // By the time lookups answer, the device has started
      clockOffset += 61 * 1000;
      answering = true;
      expect(await finder.find(signal)).to.equal("192.0.2.50");
      expect(await finder.find(signal)).to.equal("192.0.2.50");
    });

    it("leaves out what a lookup saw once it answered past the first minute", async () => {
      let lookups = 0;
      mockTauriIpc(() => {
        // The lookup starts in time, and answers after the device started
        if (lookups++ === 0) clockOffset += 61 * 1000;
        return [landingPage("device")];
      });
      const finder = new DeviceFinder();

      expect(await finder.find(signal)).to.be.null;
      expect(await finder.find(signal)).to.equal("192.0.2.50");
    });

    it("still leaves out what answered in time", async () => {
      let lookups = 0;
      mockTauriIpc(() => {
        lookups++;
        if (lookups === 1) return [landingPage("being-set-up")];
        if (lookups === 2) return Promise.reject(ipcError("io", "No network"));
        return [
          landingPage("being-set-up"),
          landingPage("device", "192.0.2.60"),
        ];
      });
      const finder = new DeviceFinder();

      await finder.find(signal).catch(() => {});
      clockOffset += 61 * 1000;
      expect(await finder.find(signal)).to.equal("192.0.2.60");
    });
  });

  it("asks nothing more once the wait ended", async () => {
    let resolveFirst!: (found: HaAnnouncement[]) => void;
    let asked = 0;
    mockTauriIpc(() => {
      asked++;
      return new Promise((resolve) => (resolveFirst = resolve));
    });
    const controller = new AbortController();
    const looking = new DeviceFinder().find(controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    resolveFirst([]);
    let caught: unknown;
    await looking.catch((error: unknown) => (caught = error));
    expect(isCancelled(caught)).to.be.true;
    expect(asked).to.equal(1);
  });

  it("knows the device that installed while the step said how to start it", async () => {
    wizardState.startFlow("sbc");
    const asked = answer(
      [],
      [],
      [landingPage("device")],
      // Home Assistant has replaced the landing page by Next
      [homeAssistant("installed")]
    );
    const step = await fixture(
      html`<test-surveying-step></test-surveying-step>`
    );

    await waitUntil(() => asked() === 3, "it stopped watching", {
      timeout: 4000,
    });
    await settle();
    step.remove();
    expect(await flowDeviceFinder().find(signal)).to.equal("192.0.2.50");
    // Found once, it isn't looked for again
    expect(asked()).to.equal(3);
  });

  it("keeps one finder for the flow, and a new one for the next", () => {
    wizardState.startFlow("sbc");
    const finder = flowDeviceFinder();
    expect(flowDeviceFinder()).to.equal(finder);

    wizardState.startFlow("sbc");
    expect(flowDeviceFinder()).not.to.equal(finder);
  });

  it("notes what is there while the step that says how to start is shown", async () => {
    wizardState.startFlow("sbc");
    const asked = answer(
      [landingPage("being-set-up")],
      [landingPage("being-set-up")],
      [landingPage("being-set-up"), landingPage("device")]
    );
    const step = await fixture(
      html`<test-surveying-step></test-surveying-step>`
    );

    await waitUntil(() => asked() === 2);
    // Its answer is in before the step goes
    await settle();
    step.remove();
    // What the waiting step finds next is new
    expect(await flowDeviceFinder().find(signal)).to.equal("192.0.2.50");
    expect(asked()).to.equal(3);
  });
});
