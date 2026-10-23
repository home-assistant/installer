import { expect } from "@open-wc/testing";
import type { HaSetupStatus } from "../../../src/api/types.js";
import {
  HaSetupStalledError,
  haSetupProblemMessage,
  waitForHaSetup,
  type HaSetupProgress,
} from "../../../src/utils/ha-setup.js";
import { installerError } from "../../../src/utils/installer-error.js";
import {
  CancelledError,
  PollTimeoutError,
} from "../../../src/utils/polling.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../tauri-ipc.js";

const MINUTE = 60 * 1000;

/** A setup status, no landing page (null), or a failed request */
type Answer = HaSetupStatus | null | "rejected";

const status = (
  progress: number | null,
  ...problems: HaSetupStatus["problems"]
): HaSetupStatus => ({
  core_install_progress: progress,
  supervisor_update_progress: null,
  problems,
});

describe("ha-setup", () => {
  const realNow = Date.now;
  let clockOffset = 0;

  beforeEach(() => {
    clockOffset = 0;
    Date.now = () => realNow.call(Date) + clockOffset;
  });

  afterEach(() => {
    Date.now = realNow;
    restoreTauriIpc();
  });

  /**
   * Answer each poll's setup status from `answers`, moving the clock by
   * `step` first. Home Assistant serves its manifest once they run out.
   */
  function mockSetup(answers: Answer[], step = 0): string[] {
    const calls: string[] = [];
    let polls = 0;
    mockTauriIpc((cmd, args) => {
      calls.push(cmd);
      expect(args).to.deep.equal({ ipAddress: "192.0.2.50" });
      switch (cmd) {
        case "check_ha_updated":
          return polls >= answers.length;
        case "get_ha_setup_status": {
          clockOffset += step;
          const answer = answers[polls++];
          return answer === "rejected"
            ? Promise.reject(ipcError("internal", "No answer"))
            : answer;
        }
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    return calls;
  }

  function wait(
    reported: HaSetupProgress[] = [],
    signal = new AbortController().signal
  ): Promise<void> {
    return waitForHaSetup("192.0.2.50", {
      interval: 1,
      timeout: 60 * MINUTE,
      signal,
      timeoutMessage: "timed out",
      onProgress: (progress) => reported.push(progress),
    });
  }

  async function stalled(promise: Promise<void>): Promise<HaSetupStalledError> {
    try {
      await promise;
    } catch (error) {
      expect(error).to.be.instanceOf(HaSetupStalledError);
      return error as HaSetupStalledError;
    }
    throw new Error("the wait did not end with a stall");
  }

  it("ends once Home Assistant serves its manifest, without asking Supervisor", async () => {
    const calls = mockSetup([]);
    await wait();
    expect(calls).to.deep.equal(["check_ha_updated"]);
  });

  it("reports the Core download, and a download at 0% as waiting", async () => {
    const reported: HaSetupProgress[] = [];
    mockSetup([status(null), status(0), status(42.5)]);
    await wait(reported);
    expect(reported).to.deep.equal([
      { progress: null, problem: null },
      { progress: null, problem: null },
      { progress: 42.5, problem: null },
    ]);
  });

  it("goes on without news when the landing page doesn't answer", async () => {
    const reported: HaSetupProgress[] = [];
    mockSetup([null, "rejected", status(10)]);
    await wait(reported);
    expect(reported).to.deep.equal([{ progress: 10, problem: null }]);
  });

  it("shows the most fundamental problem at once, and goes on waiting", async () => {
    const reported: HaSetupProgress[] = [];
    mockSetup([status(null, "no_internet", "update_failed"), status(5)]);
    await wait(reported);
    expect(reported).to.deep.equal([
      { progress: null, problem: "no_internet" },
      { progress: 5, problem: null },
    ]);
  });

  it("ends the wait when a problem holds up the download for 10 minutes", async () => {
    const reported: HaSetupProgress[] = [];
    const stuck = status(0, "update_failed");
    // Seen at 6 minutes, unchanged at 12, and at 18 it has lasted 12 minutes
    mockSetup([stuck, stuck, stuck, stuck], 6 * MINUTE);

    const error = await stalled(wait(reported));

    expect(reported).to.have.length(3);
    expect(error.problem).to.equal("update_failed");
    // A retry keeps waiting, and diagnostics get a fixed category
    expect(installerError(error)).to.deep.equal({
      code: "home_assistant_update_failed",
      message:
        "Home Assistant couldn't download an update, and is trying again. The installation made no progress for 10 minutes. Open http://192.0.2.50 to see what Home Assistant reports, or try again to keep waiting.",
      retryable: true,
      details: {},
    });
  });

  it("keeps a problem's clock running while answers don't come", async () => {
    const reported: HaSetupProgress[] = [];
    // Seen at 6 minutes, then unanswered at 12 and at 18, when it has lasted 12
    mockSetup([status(0, "free_space"), null, "rejected", null], 6 * MINUTE);

    const error = await stalled(wait(reported));

    expect(error.problem).to.equal("free_space");
    expect(reported).to.deep.equal([{ progress: null, problem: "free_space" }]);
  });

  it("doesn't count a report without a measurement as moving", async () => {
    const reported: HaSetupProgress[] = [];
    // Measured at 6 minutes, unmeasured at 12, unchanged at 18
    mockSetup(
      [50, null, 50, null].map((progress) => status(progress, "update_failed")),
      6 * MINUTE
    );

    await stalled(wait(reported));

    expect(reported).to.have.length(3);
  });

  it("reports nothing that answers after the deadline", async () => {
    const answer = deferred<HaSetupStatus | null>();
    mockTauriIpc((cmd) => {
      if (cmd === "check_ha_updated") return false;
      if (cmd === "get_ha_setup_status") return answer.promise;
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const reported: HaSetupProgress[] = [];
    let error: unknown;
    try {
      await waitForHaSetup("192.0.2.50", {
        interval: 1,
        timeout: 20,
        signal: new AbortController().signal,
        timeoutMessage: "timed out",
        onProgress: (progress) => reported.push(progress),
      });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(PollTimeoutError);

    // The view may be on a retry by now
    answer.resolve(status(50, "no_internet"));
    await settle();

    expect(reported).to.be.empty;
  });

  it("counts Supervisor updating itself as moving", async () => {
    const reported: HaSetupProgress[] = [];
    // A first pull failed, and the next one takes its time
    mockSetup(
      [10, 30, 50, 70, 90].map((update) => ({
        ...status(null, "update_failed"),
        supervisor_update_progress: update,
      })),
      6 * MINUTE
    );

    await wait(reported);

    // It isn't the Core download, so the bar keeps waiting
    expect(reported.every(({ progress }) => progress === null)).to.be.true;
  });

  it("doesn't stall once Core is downloaded and the landing page goes", async () => {
    // Downloaded at 6 minutes, then Core starts and nothing answers
    mockSetup([status(100, "update_failed"), null, null, null], 6 * MINUTE);
    await wait();
  });

  it("takes a download that starts over for not done", async () => {
    // Done at 6, starting over at 12, and still at 0% at 24
    mockSetup(
      [100, 0, 0, 0].map((progress) => status(progress, "update_failed")),
      6 * MINUTE
    );
    await stalled(wait());
  });

  it("waits on while the download moves, problem or not", async () => {
    // A download that is tried again starts over: that is moving too
    mockSetup(
      [10, 30, 0, 20, 40].map((progress) => status(progress, "update_failed")),
      6 * MINUTE
    );
    await wait();
  });

  it("starts a problem's clock over once it clears", async () => {
    mockSetup(
      [
        status(null, "no_internet"),
        status(null, "no_internet"),
        status(null),
        status(null, "no_internet"),
        status(null, "no_internet"),
      ],
      6 * MINUTE
    );
    await wait();
  });

  it("reports nothing once cancelled while asking Supervisor", async () => {
    const answer = deferred<HaSetupStatus | null>();
    const asked = deferred<void>();
    mockTauriIpc((cmd) => {
      if (cmd === "check_ha_updated") return false;
      if (cmd === "get_ha_setup_status") {
        asked.resolve();
        return answer.promise;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const controller = new AbortController();
    const reported: HaSetupProgress[] = [];
    const waiting = wait(reported, controller.signal);

    await asked.promise;
    controller.abort();
    answer.resolve(status(50, "no_internet"));
    let error: unknown;
    try {
      await waiting;
    } catch (e) {
      error = e;
    }
    await settle();

    expect(error).to.be.instanceOf(CancelledError);
    expect(reported).to.be.empty;
  });

  it("words the advice for what Home Assistant OS runs on", () => {
    expect(haSetupProblemMessage("free_space")).to.contain(
      "Give the virtual machine a larger disk."
    );
    expect(haSetupProblemMessage("free_space", "device")).to.contain(
      "Install it on a larger drive."
    );
    // And so does a stall
    expect(
      new HaSetupStalledError("free_space", "http://192.0.2.50", "device")
        .message
    ).to.contain("Install it on a larger drive.");
    // The rest is the same wherever it runs
    expect(haSetupProblemMessage("no_internet", "device")).to.equal(
      haSetupProblemMessage("no_internet")
    );
  });
});
