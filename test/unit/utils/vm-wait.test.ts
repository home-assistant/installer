import { expect } from "@open-wc/testing";
import { wizardState } from "../../../src/state/wizard-state.js";
import { PollTimeoutError } from "../../../src/utils/polling.js";
import {
  HaSetupStalledError,
  type HaSetupProgress,
} from "../../../src/utils/ha-setup.js";
import {
  WAIT_STAGES,
  checkedAddress,
  isWaitStage,
  waitError,
  waitForHomeAssistant,
  waitStageDescription,
  waitStageTitle,
  type WaitStage,
} from "../../../src/utils/vm-wait.js";
import { ipcError, mockTauriIpc, restoreTauriIpc } from "../tauri-ipc.js";

const messages = {
  noAddress: "no address",
  notResponding: (ipAddress: string) => `no answer at ${ipAddress}`,
  notUpdated: (address: string) => `not updated at ${address}`,
};

describe("vm-wait", () => {
  beforeEach(() => wizardState.startFlow("proxmox"));
  afterEach(() => {
    restoreTauriIpc();
    wizardState.reset();
  });

  // The progress's live region announces only the title
  it("names each wait differently", () => {
    const titles = WAIT_STAGES.map(waitStageTitle);
    expect(new Set(titles).size).to.equal(WAIT_STAGES.length);
    expect(titles).to.deep.equal(["Connecting", "Waiting", "Updating"]);
    expect(WAIT_STAGES.map(waitStageDescription)).to.deep.equal([
      "Waiting for network connection",
      "Waiting for Home Assistant",
      "Installing latest Home Assistant (this can take up to 20 minutes)",
    ]);
  });

  it("waits for the address, then Home Assistant, then its update", async () => {
    // A retry must not show the address of an earlier attempt
    wizardState.setSelection("ipAddress", "192.0.2.1");
    const checked: string[] = [];
    mockTauriIpc((cmd, args) => {
      checked.push(`${cmd} ${(args as { ipAddress: string }).ipAddress}`);
      return true;
    });
    const stages: WaitStage[] = [];
    const addresses: (string | undefined)[] = [];

    const ipAddress = await waitForHomeAssistant({
      address: async () => {
        addresses.push(wizardState.getState().selections.ipAddress);
        return "192.0.2.50";
      },
      stopOn: () => false,
      onStage: (stage) => stages.push(stage),
      onSetup: () => {},
      messages,
      signal: new AbortController().signal,
    });

    expect(ipAddress).to.equal("192.0.2.50");
    expect(stages).to.deep.equal(["waiting", "ready", "updating"]);
    expect(addresses).to.deep.equal([undefined]);
    expect(wizardState.getState().selections.ipAddress).to.equal("192.0.2.50");
    expect(checked).to.deep.equal([
      "check_ha_ready 192.0.2.50",
      "check_ha_updated 192.0.2.50",
    ]);
  });

  it("reports how Supervisor gets on while Home Assistant updates", async () => {
    let updated = false;
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "check_ha_ready":
          return true;
        case "check_ha_updated":
          return updated;
        case "get_ha_setup_status":
          updated = true;
          return {
            core_install_progress: 60,
            supervisor_update_progress: null,
            problems: ["docker_ratelimit"],
          };
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const reported: HaSetupProgress[] = [];

    await waitForHomeAssistant({
      address: async () => "192.0.2.50",
      stopOn: () => false,
      onStage: () => {},
      onSetup: (setup) => reported.push(setup),
      messages,
      signal: new AbortController().signal,
    });

    expect(reported).to.deep.equal([
      { progress: 60, problem: "docker_ratelimit" },
    ]);
  });

  it("ends the address wait right away on an error asking again can't fix", async () => {
    const expired = ipcError("proxmox_session_expired", "Session expired");
    let asked = 0;
    const wait = waitForHomeAssistant({
      address: async () => {
        asked++;
        throw expired;
      },
      stopOn: (error) => error === expired,
      onStage: () => {},
      onSetup: () => {},
      messages,
      signal: new AbortController().signal,
    });

    let caught: unknown;
    await wait.catch((error) => (caught = error));
    expect(caught).to.equal(expired);
    expect(asked).to.equal(1);
  });

  it("waits for the address as long as it is told, and can stop asking", async () => {
    mockTauriIpc(() => true);
    const realNow = Date.now;
    let clockOffset = 0;
    Date.now = () => realNow.call(Date) + clockOffset;
    const controller = new AbortController();
    let asked: AbortSignal | undefined;
    try {
      const ipAddress = await waitForHomeAssistant({
        address: async (signal) => {
          asked = signal;
          // Past a VM's five minutes
          clockOffset += 6 * 60 * 1000;
          return "192.0.2.50";
        },
        addressTimeout: 30 * 60 * 1000,
        stopOn: () => false,
        onStage: () => {},
        onSetup: () => {},
        messages,
        signal: controller.signal,
      });
      expect(ipAddress).to.equal("192.0.2.50");
      // So a lookup in steps can stop between them
      expect(asked).to.equal(controller.signal);
    } finally {
      Date.now = realNow;
    }
  });

  it("shows the checked address only while Home Assistant is checked", () => {
    expect(checkedAddress("waiting", "192.0.2.50")).to.be.null;
    expect(checkedAddress("ready", undefined)).to.be.null;
    expect(checkedAddress("ready", "192.0.2.50")).to.equal("http://192.0.2.50");
    expect(checkedAddress("updating", "192.0.2.50")).to.equal(
      "http://192.0.2.50"
    );
  });

  it("treats only the waits as stages to leave during", () => {
    for (const stage of ["waiting", "ready", "updating"]) {
      expect(isWaitStage(stage), stage).to.be.true;
    }
    for (const stage of ["starting", "creating_vm", "complete", "error"]) {
      expect(isWaitStage(stage), stage).to.be.false;
    }
  });

  it("makes a wait that ran out a retryable timeout", () => {
    expect(waitError(new PollTimeoutError("no answer"))).to.deep.equal({
      code: "timeout",
      message: "no answer",
      retryable: true,
      details: {},
    });
    const other = new Error("other");
    expect(waitError(other)).to.equal(other);
    // Already shaped like a backend error, with its own retryable code
    const stalled = new HaSetupStalledError("no_internet", "http://192.0.2.50");
    expect(waitError(stalled)).to.equal(stalled);
  });
});
