import {
  expect,
  fixtureSync,
  html,
  oneEvent,
  waitUntil,
} from "@open-wc/testing";
import type { FlashProgress } from "../../../src/api/types.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import type { InstallFailure } from "../../../src/views/install-progress-view.js";
import { VmProgressView } from "../../../src/views/vm-progress-view.js";
import { showsError } from "../helpers/progress-error.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
  type Deferred,
} from "../tauri-ipc.js";

type TestStage = "downloading" | "building";

/** What a test plays as the flow's steps, on the view they report to */
type Steps = (view: TestProgressView, signal: AbortSignal) => Promise<void>;

/** A made-up flow: a download a stop can end, then one more step */
class TestProgressView extends VmProgressView<TestStage> {
  protected readonly _flow = "utm";
  protected readonly _stages: readonly TestStage[] = [
    "downloading",
    "building",
  ];
  protected readonly _stoppableStages: readonly TestStage[] = ["downloading"];
  protected readonly _measurableStages: readonly TestStage[] = ["downloading"];

  steps: Steps = () => new Promise(() => {});
  startFailure?: InstallFailure;

  protected _stoppedMessage() {
    return "Stopped. Nothing was built.";
  }

  protected _stageTitle(stage: TestStage) {
    return stage === "downloading" ? "Fetching" : "Building";
  }

  protected _stageDescription(stage: TestStage) {
    return stage === "downloading" ? "Fetching the image" : "Building the VM";
  }

  protected _startFailure() {
    return this.startFailure;
  }

  protected _install(signal: AbortSignal) {
    return this.steps(this, signal);
  }

  // What a flow's steps see and call, opened up to the tests
  get stage() {
    return this._stage;
  }

  runBackendStep<T>(step: (attempt: string) => Promise<T>): Promise<T> {
    return this._runBackendStep(step);
  }

  showProgress(stage: TestStage, progress: FlashProgress) {
    this._showProgress(stage, progress);
  }

  startStage(stage: TestStage) {
    this._startStage(stage);
  }

  waitForHomeAssistant(
    signal: AbortSignal,
    address = async (): Promise<string | null> => "192.0.2.50"
  ) {
    return this._waitForHomeAssistant(
      {
        address,
        stopOn: () => false,
        messages: {
          noAddress: "No address",
          notResponding: () => "No answer",
          notUpdated: () => "Not updated",
        },
      },
      signal
    );
  }
}
customElements.define("test-vm-progress-view", TestProgressView);

/** Mount the view, which starts the install with `steps` as it connects */
function mount(steps?: Steps, startFailure?: InstallFailure): TestProgressView {
  const el = document.createElement(
    "test-vm-progress-view"
  ) as TestProgressView;
  if (steps) el.steps = steps;
  el.startFailure = startFailure;
  fixtureSync(html`<div>${el}</div>`);
  return el;
}

function layoutOf(el: TestProgressView) {
  return el.shadowRoot!.querySelector("install-progress")!;
}

function progress(value: number): FlashProgress {
  return {
    stage: "downloading",
    progress: value,
    bytes_processed: value * 10,
    total_bytes: 1000,
    message: "",
  };
}

describe("vm-progress-view", () => {
  beforeEach(() => {
    wizardState.startFlow("vm");
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  it("rejects a stage the flow doesn't have at build time", () => {
    abstract class Misspelled extends VmProgressView<TestStage> {
      // @ts-expect-error: misspelled stage
      protected readonly _stoppableStages = ["downloadng"] as const;
      // @ts-expect-error: misspelled stage
      protected readonly _measurableStages = ["buildng"] as const;
    }
    expect(Misspelled).to.be.a("function");
  });

  it("completes once the flow's steps are done", async () => {
    const el = mount(async () => {});

    const completed = await oneEvent(el, "install-complete");
    await el.updateComplete;

    expect(completed.detail).to.equal(null);
    expect(layoutOf(el).stage).to.equal("complete");
    expect(layoutOf(el).progress).to.equal(100);
  });

  it("shows a failure to start at once, without running a step", async () => {
    let ran = false;
    let errors = 0;
    const onError = () => errors++;
    document.addEventListener("install-error", onError);
    try {
      const el = mount(
        async () => {
          ran = true;
        },
        {
          error: ipcError("test_blocked", "Blocked", false),
          message: "Nothing to install with",
        }
      );

      expect(errors).to.equal(1);
      await el.updateComplete;
      expect(showsError(el)).to.be.true;
      expect(layoutOf(el).error).to.equal("Nothing to install with");

      el.retry();
      expect(ran).to.be.false;
    } finally {
      document.removeEventListener("install-error", onError);
    }
  });

  it("retries a retryable failure from the download, and only that", async () => {
    let runs = 0;
    const stages: string[] = [];
    const el = mount(async (view) => {
      runs++;
      stages.push(view.stage);
      view.startStage("building");
      throw ipcError("test_failure", "Test failure", runs === 1);
    });

    const failed = await oneEvent(el, "install-error");
    expect(failed.detail.retryable).to.be.true;
    await el.updateComplete;
    expect(layoutOf(el).error).to.equal("Test failure");

    const failedAgain = oneEvent(el, "install-error");
    el.retry();
    expect((await failedAgain).detail.retryable).to.be.false;

    el.retry();
    await settle();
    expect(runs).to.equal(2);
    expect(stages).to.deep.equal(["downloading", "downloading"]);
  });

  it("clears what the failed attempt got through when it is tried again", async () => {
    let runs = 0;
    const el = mount(async (view) => {
      if (++runs > 1) return new Promise(() => {});
      await view.runBackendStep(() => Promise.resolve());
      view.showProgress("downloading", progress(30));
      view.showProgress("building", { ...progress(60), stage: "creating_vm" });
      throw ipcError("test_failure", "Test failure", true);
    });
    await oneEvent(el, "install-error");
    await el.updateComplete;
    const layout = layoutOf(el);
    expect(layout.bytesProcessed).to.equal(600);
    expect(layout.totalBytes).to.equal(1000);
    expect(layout.stageStartBytes).to.equal(600);

    // The new attempt has not reported anything yet
    el.retry();
    await el.updateComplete;
    expect(layout.stage).to.equal("downloading");
    expect(layout.progress).to.equal(0);
    expect(layout.bytesProcessed).to.equal(0);
    expect(layout.totalBytes).to.equal(0);
    expect(layout.stageStartTime).to.be.null;
    expect(layout.stageStartBytes).to.equal(0);
    el.remove();
  });

  it("starts each backend step with no counts from the one before", async () => {
    const first = deferred<void>();
    const el = mount(async (view) => {
      await view.runBackendStep(() => first.promise);
      await view.runBackendStep(() => new Promise(() => {}));
    });
    await el.updateComplete;
    el.showProgress("downloading", progress(30));
    await el.updateComplete;
    const layout = layoutOf(el);
    expect(layout.bytesProcessed).to.equal(300);

    first.resolve();
    await settle();
    await el.updateComplete;
    expect(layout.stage).to.equal("downloading");
    expect(layout.progress).to.equal(0);
    expect(layout.bytesProcessed).to.equal(0);
    expect(layout.totalBytes).to.equal(0);
    el.remove();
  });

  it("tells the shell when the install can be stopped, and when left", async () => {
    const download = deferred<void>();
    const ready = deferred<boolean>();
    mockTauriIpc((cmd) => {
      if (cmd === "check_ha_ready") return ready.promise;
      if (cmd === "check_ha_updated") return true;
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = mount(async (view, signal) => {
      await view.runBackendStep(() => download.promise);
      view.startStage("building");
      await view.waitForHomeAssistant(signal);
    });
    const stoppable: boolean[] = [];
    const leavable: boolean[] = [];
    el.addEventListener("install-stoppable", (event) =>
      stoppable.push(event.detail.stoppable)
    );
    el.addEventListener("install-leavable", (event) =>
      leavable.push(event.detail.leavable)
    );

    await el.updateComplete;
    expect(stoppable).to.deep.equal([true]);
    expect(leavable).to.deep.equal([false]);

    download.resolve();
    // Once the VM runs, only Home Assistant is awaited
    await waitUntil(() => el.leavable, "never leavable while waiting");
    await el.updateComplete;
    expect(stoppable).to.deep.equal([true, false]);
    expect(leavable).to.deep.equal([false, true]);

    const completed = oneEvent(el, "install-complete");
    ready.resolve(true);
    await completed;
    await el.updateComplete;
    expect(leavable).to.deep.equal([false, true, false]);
  });

  describe("stop", () => {
    /**
     * Hold every backend step and every stop request open, and record the
     * attempt each one names.
     */
    function mockStops() {
      const steps: Deferred<void>[] = [];
      const attempts: string[] = [];
      const stops: Deferred<void>[] = [];
      const stopped: string[] = [];
      mockTauriIpc((cmd, args) => {
        if (cmd === "cancel_vm_install") {
          stopped.push((args as { attempt: string }).attempt);
          const stop = deferred<void>();
          stops.push(stop);
          return stop.promise;
        }
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });
      const el = mount(async (view) => {
        const step = deferred<void>();
        steps.push(step);
        await view.runBackendStep((attempt) => {
          attempts.push(attempt);
          return step.promise;
        });
      });
      return { el, steps, attempts, stops, stopped };
    }

    it("stops the attempt it names, and says what that left behind", async () => {
      const { el, steps, attempts, stopped } = mockStops();
      await el.updateComplete;

      el.stop();
      expect(el.stoppable, "a second stop has nothing to add").to.be.false;
      expect(stopped).to.deep.equal([attempts[0]]);
      await el.updateComplete;
      expect(layoutOf(el).stageTitle).to.equal("Stopping");

      const failed = oneEvent(el, "install-error");
      steps[0].reject(
        ipcError("cancelled", "Installation was cancelled.", true)
      );
      expect((await failed).detail.retryable).to.be.true;
      await el.updateComplete;
      expect(layoutOf(el).error).to.equal("Stopped. Nothing was built.");
    });

    it("offers the stop again when the request fails", async () => {
      const { el, stops } = mockStops();
      await el.updateComplete;

      el.stop();
      stops[0].reject(new Error("IPC unavailable"));
      await settle();

      expect(el.stoppable).to.be.true;
      await el.updateComplete;
      expect(layoutOf(el).stageTitle).to.equal("Fetching");
    });

    it("leaves a retry alone when an earlier stop request fails late", async () => {
      const { el, steps, attempts, stops, stopped } = mockStops();
      await el.updateComplete;
      el.stop();
      const failed = oneEvent(el, "install-error");
      steps[0].reject(
        ipcError("cancelled", "Installation was cancelled.", true)
      );
      await failed;

      el.retry();
      el.stop();
      expect(stopped).to.deep.equal([attempts[0], attempts[1]]);
      expect(attempts[1]).to.not.equal(attempts[0]);

      // The first attempt's stop request fails only now
      stops[0].reject(new Error("IPC unavailable"));
      await settle();
      await el.updateComplete;
      expect(layoutOf(el).stageTitle).to.equal("Stopping");
      expect(el.stoppable).to.be.false;
    });
  });

  for (const leave of ["detached", "a new flow started"]) {
    it(`drops the install's result once ${leave}`, async () => {
      const result = deferred<void>();
      let signal!: AbortSignal;
      const el = mount((_view, attemptSignal) => {
        signal = attemptSignal;
        return result.promise;
      });
      const events: string[] = [];
      el.addEventListener("install-complete", () => events.push("complete"));
      el.addEventListener("install-error", () => events.push("error"));

      if (leave === "detached") el.remove();
      else wizardState.startFlow("vm");
      expect(signal.aborted).to.be.true;

      result.resolve();
      await settle();
      expect(events).to.deep.equal([]);
      expect(showsError(el)).to.be.false;
    });
  }

  it("names each stage, and each wait on its own", async () => {
    const download = deferred<void>();
    const built = deferred<void>();
    const address = deferred<string>();
    mockTauriIpc((cmd) => {
      if (cmd === "check_ha_ready") return new Promise(() => {});
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = mount(async (view, signal) => {
      await view.runBackendStep(() => download.promise);
      view.startStage("building");
      await built.promise;
      await view.waitForHomeAssistant(signal, () => address.promise);
    });
    await el.updateComplete;
    const layout = layoutOf(el);
    const shown = () => [layout.stage, layout.stageTitle, layout.description];

    expect(shown()).to.deep.equal([
      "downloading",
      "Fetching",
      "Fetching the image",
    ]);
    expect(layout.stages.map((stage) => stage.label)).to.deep.equal([
      "Fetching the image",
      "Building the VM",
      "Waiting for network connection",
      "Waiting for Home Assistant",
      "Installing latest Home Assistant",
    ]);

    download.resolve();
    await waitUntil(() => layout.stage === "building");
    expect(shown()).to.deep.equal(["building", "Building", "Building the VM"]);

    // The live region announces only the title, so it changes with each wait
    built.resolve();
    await waitUntil(() => layout.stage === "waiting");
    expect(shown()).to.deep.equal([
      "waiting",
      "Connecting",
      "Waiting for network connection",
    ]);
    // An indeterminate wait has no byte counts to keep a row for
    expect(layout.hideEmptyDetails).to.be.true;
    await layout.updateComplete;
    expect(!!layout.shadowRoot!.querySelector(".progress-details")).to.be.false;

    address.resolve("192.0.2.50");
    await waitUntil(() => layout.stage === "ready");
    expect(shown()).to.deep.equal([
      "ready",
      "Waiting",
      "Waiting for Home Assistant",
    ]);
    el.remove();
  });

  it("shows the backend's progress in whole percent", async () => {
    const el = mount(async (view) => {
      await view.runBackendStep(() => new Promise(() => {}));
    });
    await el.updateComplete;
    const layout = layoutOf(el);

    el.showProgress("downloading", progress(42.6));
    await el.updateComplete;
    expect(layout.progress).to.equal(43);
    await layout.updateComplete;
    expect(
      layout.shadowRoot!.querySelector(".percentage")!.textContent
    ).to.equal("43%");

    // A new stage starts its own timing; a known one keeps it
    const started = layout.stageStartTime;
    el.showProgress("downloading", progress(50));
    await el.updateComplete;
    expect(layout.stageStartTime).to.equal(started);
    el.showProgress("building", { ...progress(10), stage: "creating_vm" });
    await el.updateComplete;
    expect(layout.stage).to.equal("building");
    expect(layout.stageStartBytes).to.equal(100);
    el.remove();
  });
});
