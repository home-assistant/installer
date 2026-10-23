import { expect } from "@open-wc/testing";
import type { HaAnnouncement } from "../../../src/api/types.js";
import { newLandingPageFinder } from "../../../src/utils/device-discovery.js";
import type { InstallerError } from "../../../src/utils/installer-error.js";
import { isCancelled } from "../../../src/utils/polling.js";
import { ipcError, mockTauriIpc, restoreTauriIpc } from "../tauri-ipc.js";

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

describe("device-discovery", () => {
  const signal = new AbortController().signal;

  afterEach(restoreTauriIpc);

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
    const find = newLandingPageFinder();

    expect(await find(signal)).to.be.null;
    expect(asked()).to.equal(2);
    expect(await find(signal)).to.equal("192.0.2.60");
  });

  it("checks on the device where it was found once, without looking again", async () => {
    // Home Assistant has replaced the landing page by the time it is asked
    const asked = answer(
      [],
      [],
      [landingPage("device")],
      [homeAssistant("new")]
    );
    const find = newLandingPageFinder();

    expect(await find(signal)).to.be.null;
    expect(await find(signal)).to.equal("192.0.2.50");
    expect(await find(signal)).to.equal("192.0.2.50");
    expect(asked()).to.equal(3);
  });

  it("never takes Home Assistant itself for the device", async () => {
    // One that was off while the first lookups ran
    answer([], [], [homeAssistant("back-on")]);
    const find = newLandingPageFinder();

    expect(await find(signal)).to.be.null;
    expect(await find(signal)).to.be.null;
  });

  it("notes what is there again when a first lookup failed", async () => {
    const asked = answer(
      ipcError("io", "No network"),
      [landingPage("being-set-up")],
      [landingPage("being-set-up")],
      [landingPage("being-set-up"), landingPage("device")]
    );
    const find = newLandingPageFinder();

    let caught: unknown;
    await find(signal).catch((error) => (caught = error));
    expect(caught).to.deep.include({ code: "io" });
    expect(await find(signal)).to.be.null;
    expect(asked()).to.equal(3);
    expect(await find(signal)).to.equal("192.0.2.50");
  });

  it("asks nothing more once the wait ended", async () => {
    let resolveFirst!: (found: HaAnnouncement[]) => void;
    let asked = 0;
    mockTauriIpc(() => {
      asked++;
      return new Promise((resolve) => (resolveFirst = resolve));
    });
    const controller = new AbortController();
    const looking = newLandingPageFinder()(controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    resolveFirst([]);
    let caught: unknown;
    await looking.catch((error) => (caught = error));
    expect(isCancelled(caught)).to.be.true;
    expect(asked).to.equal(1);
  });
});
