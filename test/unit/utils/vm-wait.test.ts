import { expect } from "@open-wc/testing";
import { wizardState } from "../../../src/state/wizard-state.js";
import { PollTimeoutError } from "../../../src/utils/polling.js";
import {
  checkedAddress,
  isWaitStage,
  waitError,
  waitForHomeAssistant,
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
      vmAddress: async () => {
        addresses.push(wizardState.getState().selections.ipAddress);
        return "192.0.2.50";
      },
      stopOn: () => false,
      onStage: (stage) => stages.push(stage),
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

  it("ends the address wait right away on an error asking again can't fix", async () => {
    const expired = ipcError("proxmox_session_expired", "Session expired");
    let asked = 0;
    const wait = waitForHomeAssistant({
      vmAddress: async () => {
        asked++;
        throw expired;
      },
      stopOn: (error) => error === expired,
      onStage: () => {},
      messages,
      signal: new AbortController().signal,
    });

    let caught: unknown;
    await wait.catch((error) => (caught = error));
    expect(caught).to.equal(expired);
    expect(asked).to.equal(1);
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
  });
});
