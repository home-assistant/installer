import { expect, waitUntil } from "@open-wc/testing";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { HaAnnouncement } from "../../../src/api/types.js";
import {
  HomeAssistantScan,
  SCAN_INTERVAL_MS,
} from "../../../src/utils/home-assistant-scan.js";
import type { InstallerError } from "../../../src/utils/installer-error.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../tauri-ipc.js";

/** A host that counts how often the scan has it render again */
class Host implements ReactiveControllerHost {
  updates = 0;
  readonly updateComplete = Promise.resolve(true);
  addController(_controller: ReactiveController) {}
  removeController(_controller: ReactiveController) {}
  requestUpdate() {
    this.updates++;
  }
}

const homeAssistant = (
  address: string,
  name: string | null = "Home",
  url = `http://${address}/`
): HaAnnouncement => ({ id: address, name, address, url, landing_page: false });

const landingPage = (address: string, id = address): HaAnnouncement => ({
  id,
  name: "Home (preparing setup)",
  address,
  url: `http://${address}/`,
  landing_page: true,
});

type Answer<T> = T | InstallerError | Promise<T>;

/**
 * Answer the lookups in turn, the last one again once they run out, and the
 * onboarding checks of each address in turn the same way. Records the
 * addresses checked.
 */
function network(
  lookups: Answer<HaAnnouncement[]>[],
  onboarded: Record<string, Answer<boolean | null>[]> = {}
) {
  let looked = 0;
  const checks: Record<string, number> = {};
  const checked: string[] = [];
  const reply = <T>(answer: Answer<T>) =>
    answer && typeof answer === "object" && "code" in answer
      ? Promise.reject(answer)
      : answer;
  mockTauriIpc((cmd, args) => {
    if (cmd === "find_home_assistants") {
      return reply(lookups[Math.min(looked++, lookups.length - 1)]);
    }
    if (cmd === "check_ha_onboarded") {
      const { ipAddress } = args as { ipAddress: string };
      checked.push(ipAddress);
      const answers = onboarded[ipAddress] ?? [null];
      const index = checks[ipAddress] ?? 0;
      checks[ipAddress] = index + 1;
      return reply(answers[Math.min(index, answers.length - 1)]);
    }
    throw new Error(`Unexpected IPC command: ${cmd}`);
  });
  return { looked: () => looked, checked };
}

describe("home-assistant-scan", () => {
  const setTimeout = window.setTimeout;
  /** The wait before the next lookup, held until a test ends it */
  let pause: (() => void) | undefined;
  let host: Host;
  let scan: HomeAssistantScan;

  beforeEach(() => {
    pause = undefined;
    window.setTimeout = ((
      handler: () => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout !== SCAN_INTERVAL_MS)
        return setTimeout(handler, timeout, ...args);
      pause = handler;
      return 0;
    }) as typeof window.setTimeout;
    host = new Host();
    scan = new HomeAssistantScan(host);
  });

  afterEach(() => {
    scan.hostDisconnected();
    window.setTimeout = setTimeout;
    restoreTauriIpc();
  });

  /** Until the scan waits for its next lookup */
  const looked = () => waitUntil(() => pause, "the lookup didn't end");

  /** End the wait, and look up again */
  async function lookAgain() {
    const next = pause!;
    pause = undefined;
    next();
    await looked();
  }

  it("shows each Home Assistant by name, with what it is ready for", async () => {
    const { checked } = network(
      [
        [
          homeAssistant(
            "192.0.2.30:8123",
            "Cabin",
            "https://cabin.example:8123/"
          ),
          homeAssistant("192.0.2.20:8123", "Home"),
          landingPage("192.0.2.50"),
          homeAssistant("192.0.2.40:8123", null),
        ],
      ],
      {
        "192.0.2.20:8123": [true],
        "192.0.2.30:8123": [false],
        "192.0.2.40:8123": [null],
      }
    );

    scan.hostConnected();
    await looked();

    expect(scan.found).to.deep.equal([
      {
        address: "192.0.2.30:8123",
        url: "https://cabin.example:8123/",
        name: "Cabin",
        state: "not_onboarded",
      },
      {
        address: "192.0.2.20:8123",
        url: "http://192.0.2.20:8123/",
        name: "Home",
        state: "onboarded",
      },
      {
        address: "192.0.2.50",
        url: "http://192.0.2.50/",
        name: "Home (preparing setup)",
        state: "installing",
      },
      {
        address: "192.0.2.40:8123",
        url: "http://192.0.2.40:8123/",
        name: null,
        state: "unknown",
      },
    ]);
    // A landing page isn't asked: Home Assistant isn't installed yet
    expect(checked).to.have.members([
      "192.0.2.20:8123",
      "192.0.2.30:8123",
      "192.0.2.40:8123",
    ]);
    expect(host.updates).to.equal(1);
  });

  it("shows one only once it said whether it is onboarded", async () => {
    const check = deferred<boolean | null>();
    network([[homeAssistant("192.0.2.20:8123")]], {
      "192.0.2.20:8123": [check.promise],
    });

    scan.hostConnected();
    await settle();
    expect(scan.found).to.deep.equal([]);
    expect(host.updates).to.equal(0);

    check.resolve(false);
    await looked();
    expect(scan.found.map(({ state }) => state)).to.deep.equal([
      "not_onboarded",
    ]);
  });

  it("keeps one a lookup missed, until the next one misses it too", async () => {
    const home = homeAssistant("192.0.2.20:8123");
    const cabin = homeAssistant("192.0.2.30:8123", "Cabin");
    network([[cabin, home], [home], [home], [cabin, home]]);

    scan.hostConnected();
    await looked();
    expect(scan.found.map(({ name }) => name)).to.deep.equal(["Cabin", "Home"]);

    await lookAgain();
    expect(scan.found.map(({ name }) => name)).to.deep.equal(["Cabin", "Home"]);

    await lookAgain();
    expect(scan.found.map(({ name }) => name)).to.deep.equal(["Home"]);

    await lookAgain();
    expect(scan.found.map(({ name }) => name)).to.deep.equal(["Cabin", "Home"]);
  });

  it("keeps what it found through a lookup that failed, and looks again", async () => {
    const { looked: lookups } = network(
      [
        [homeAssistant("192.0.2.20:8123")],
        ipcError("io", "No network"),
        ipcError("io", "No network"),
        [],
      ],
      { "192.0.2.20:8123": [true] }
    );

    scan.hostConnected();
    await looked();
    await lookAgain();
    await lookAgain();
    expect(lookups()).to.equal(3);
    expect(scan.found).to.deep.equal([
      {
        address: "192.0.2.20:8123",
        url: "http://192.0.2.20:8123/",
        name: "Home",
        state: "onboarded",
      },
    ]);

    // Only lookups that answered count as missing it
    await lookAgain();
    expect(scan.found).to.have.length(1);
  });

  it("keeps what Home Assistant said about onboarding when a check doesn't tell", async () => {
    network([[homeAssistant("192.0.2.20:8123")]], {
      "192.0.2.20:8123": [false, null, ipcError("io", "Timed out"), true],
    });

    scan.hostConnected();
    await looked();
    await lookAgain();
    await lookAgain();
    expect(scan.found[0].state).to.equal("not_onboarded");

    // Onboarded in the browser meanwhile
    await lookAgain();
    expect(scan.found[0].state).to.equal("onboarded");
  });

  it("shows Home Assistant rather than the landing page it replaced", async () => {
    const address = "192.0.2.50";
    const { checked } = network(
      [
        [landingPage(address, "landing-page")],
        // The landing page's announcement lingers a little
        [
          landingPage(address, "landing-page"),
          { ...homeAssistant(address), id: "core" },
        ],
      ],
      { [address]: [false] }
    );

    scan.hostConnected();
    await looked();
    expect(scan.found.map(({ state }) => state)).to.deep.equal(["installing"]);
    expect(checked).to.deep.equal([]);

    await lookAgain();
    expect(scan.found).to.deep.equal([
      {
        address,
        url: `http://${address}/`,
        name: "Home",
        state: "not_onboarded",
      },
    ]);
  });

  it("forgets a landing page Home Assistant replaced on another port", async () => {
    const { checked } = network(
      [
        [landingPage("192.0.2.50")],
        // Its announcement lingers beside Home Assistant's own
        [landingPage("192.0.2.50"), homeAssistant("192.0.2.50:8123")],
      ],
      { "192.0.2.50:8123": [false] }
    );

    scan.hostConnected();
    await looked();
    expect(scan.found.map(({ state }) => state)).to.deep.equal(["installing"]);

    await lookAgain();
    expect(scan.found).to.deep.equal([
      {
        address: "192.0.2.50:8123",
        url: "http://192.0.2.50:8123/",
        name: "Home",
        state: "not_onboarded",
      },
    ]);
    expect(checked).to.deep.equal(["192.0.2.50:8123"]);
  });

  it("forgets a kept landing page once Home Assistant answers instead", async () => {
    network(
      [
        [landingPage("192.0.2.50")],
        // Missed once, so kept, as Home Assistant answers on its own port
        [homeAssistant("192.0.2.50:8123")],
      ],
      { "192.0.2.50:8123": [true] }
    );

    scan.hostConnected();
    await looked();
    await lookAgain();
    expect(scan.found.map(({ address }) => address)).to.deep.equal([
      "192.0.2.50:8123",
    ]);
  });

  it("keeps each Home Assistant on its own port of a device", async () => {
    network([
      [
        homeAssistant("192.0.2.20:8123", "Home"),
        homeAssistant("192.0.2.20:8124", "Test"),
        // Only another device's landing page
        landingPage("192.0.2.50"),
      ],
    ]);

    scan.hostConnected();
    await looked();
    expect(scan.found.map(({ address }) => address)).to.deep.equal([
      "192.0.2.20:8123",
      "192.0.2.50",
      "192.0.2.20:8124",
    ]);
  });

  it("stops looking once its host is gone", async () => {
    const lookup = deferred<HaAnnouncement[]>();
    const { looked: lookups, checked } = network([lookup.promise]);

    scan.hostConnected();
    await settle();
    scan.hostDisconnected();
    lookup.resolve([homeAssistant("192.0.2.20:8123")]);
    await settle();

    expect(scan.found).to.deep.equal([]);
    expect(host.updates).to.equal(0);
    expect(pause).to.be.undefined;
    expect(lookups()).to.equal(1);
    // Nor does it ask the Home Assistant it found
    expect(checked).to.deep.equal([]);
  });

  it("drops what a check finds once its host is gone", async () => {
    const check = deferred<boolean | null>();
    network([[homeAssistant("192.0.2.20:8123")]], {
      "192.0.2.20:8123": [check.promise],
    });

    scan.hostConnected();
    await settle();
    scan.hostDisconnected();
    check.resolve(true);
    await settle();

    expect(scan.found).to.deep.equal([]);
    expect(host.updates).to.equal(0);
  });
});
