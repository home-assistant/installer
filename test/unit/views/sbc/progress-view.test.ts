import { expect, fixtureSync, html } from "@open-wc/testing";
import type { Channel } from "@tauri-apps/api/core";
import type {
  FlashProgress,
  FlashRequest,
  FlashResult,
} from "../../../../src/api/types.js";
import {
  MOCK_BLOCK_DEVICES,
  MOCK_MANIFEST,
} from "../../../../src/api/mock-data.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import { storeDriveSelection } from "../../../../src/utils/drive-selection.js";
import "../../../../src/views/sbc/progress-view.js";
import type { ProgressView } from "../../../../src/views/sbc/progress-view.js";
import {
  deferred,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

function mockFlash() {
  storeDriveSelection(MOCK_BLOCK_DEVICES[0]);
  wizardState.setSelection("deviceConfig", MOCK_MANIFEST.devices[0].haos);
  const attempts: Array<{
    request: FlashRequest;
    progressChannel: Channel<FlashProgress>;
    result: ReturnType<typeof deferred<FlashResult>>;
  }> = [];
  mockTauriIpc((cmd, args) => {
    expect(cmd).to.equal("flash_image");
    const result = deferred<FlashResult>();
    attempts.push({ ...(args as (typeof attempts)[number]), result });
    return result.promise;
  });
  const el = fixtureSync<ProgressView>(html`<progress-view></progress-view>`);
  return { el, attempts };
}

describe("progress-view", () => {
  beforeEach(() => {
    wizardState.startFlow("sbc");
    // Nothing may reach the backend when the selections are incomplete
    mockTauriIpc((cmd) => {
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  it("renders write progress and reports completion with the selected drive identity", async () => {
    const { el, attempts } = mockFlash();
    let completed = 0;
    let errors = 0;
    el.addEventListener("flash-complete", () => completed++);
    el.addEventListener("flash-error", () => errors++);
    expect(attempts[0].request).to.deep.equal({
      device_id: MOCK_BLOCK_DEVICES[0].id,
      board: "rpi5-64",
      verify: true,
      expected_device: {
        size: MOCK_BLOCK_DEVICES[0].size,
        model: MOCK_BLOCK_DEVICES[0].model,
        vendor: MOCK_BLOCK_DEVICES[0].vendor,
        // The backend re-checks the hardware serial right before writing
        serial: MOCK_BLOCK_DEVICES[0].serial,
      },
    });
    const progress: FlashProgress = {
      stage: "writing",
      progress: 50,
      bytes_processed: 1024,
      total_bytes: 2048,
      message: "Writing image",
    };
    attempts[0].progressChannel.onmessage(progress);
    await settle();
    expect(
      el
        .shadowRoot!.querySelector("install-progress")!
        .shadowRoot!.querySelector("progress-bar")!.progress
    ).to.equal(50);
    expect(completed).to.equal(0);
    attempts[0].progressChannel.onmessage({
      ...progress,
      stage: "complete",
      progress: 100,
    });
    attempts[0].result.resolve({ duration_secs: 1 });
    await settle();
    expect(completed).to.equal(1);
    expect(errors).to.equal(0);
    expect(el.hasError).to.be.false;
  });

  // Commands reject with structured errors; only retryable ones may retry here
  it("shows a retryable write failure and retries the same request", async () => {
    const { el, attempts } = mockFlash();
    let completed = 0;
    let errors = 0;
    el.addEventListener("flash-complete", () => completed++);
    el.addEventListener("flash-error", () => errors++);
    attempts[0].result.reject({
      code: "device_busy",
      message: "Write failed: I/O error",
      retryable: true,
      details: {},
    });
    await settle();
    expect(el.hasError).to.be.true;
    expect(
      el
        .shadowRoot!.querySelector("install-progress")!
        .shadowRoot!.querySelector(".error-message")!.textContent
    ).to.contain("The drive is in use");
    expect(errors).to.equal(1);
    expect(completed).to.equal(0);
    el.retry();
    await settle();
    expect(attempts).to.have.length(2);
    expect(attempts[1].request).to.deep.equal(attempts[0].request);
    expect(el.hasError).to.be.false;
    expect(
      el
        .shadowRoot!.querySelector("install-progress")!
        .shadowRoot!.querySelector(".error-message")
    ).to.equal(null);
    attempts[1].progressChannel.onmessage({
      stage: "complete",
      progress: 100,
      bytes_processed: 2048,
      total_bytes: 2048,
      message: "Complete",
    });
    attempts[1].result.resolve({ duration_secs: 1 });
    await settle();
    expect(completed).to.equal(1);
    expect(errors).to.equal(1);
  });

  it("does not retry a disconnected drive in place", async () => {
    const { el, attempts } = mockFlash();
    attempts[0].result.reject({
      code: "drive_disconnected",
      message: "Drive disconnected",
      retryable: false,
      details: {},
    });
    await settle();
    expect(
      el
        .shadowRoot!.querySelector("install-progress")!
        .shadowRoot!.querySelector(".error-message")!.textContent
    ).to.contain("select your drive again");
    el.retry();
    await settle();
    expect(attempts).to.have.length(1);
    expect(el.hasError).to.be.true;
  });

  it("reports a failed verification without advancing", async () => {
    const { el, attempts } = mockFlash();
    let completed = false;
    el.addEventListener("flash-complete", () => {
      completed = true;
    });
    // Failures reject with a structured error; there is no unsuccessful result
    attempts[0].result.reject({
      code: "verification_failed",
      message: "Verification failed",
      retryable: false,
      details: {},
    });
    await settle();
    expect(
      el
        .shadowRoot!.querySelector("install-progress")!
        .shadowRoot!.querySelector(".error-message")!.textContent
    ).to.contain("could not be verified");
    expect(completed).to.be.false;
  });

  it("labels measurable extraction counters as compressed bytes", async () => {
    wizardState.setSelection("drive", "mock-drive");
    wizardState.setSelection("deviceConfig", {
      board: "rpi5-64",
      download_url: "https://example.test/image.xz",
      minimum_storage_bytes: 16_000_000_000,
      recommended_storage_bytes: 32_000_000_000,
    });
    let channel!: Channel<FlashProgress>;
    mockTauriIpc((cmd, args) => {
      if (cmd === "flash_image") {
        channel = (args as { progressChannel: Channel<FlashProgress> })
          .progressChannel;
        return new Promise(() => {});
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = fixtureSync<ProgressView>(html`<progress-view></progress-view>`);
    channel.onmessage({
      stage: "extracting",
      progress: 25,
      bytes_processed: 25_000,
      total_bytes: 100_000,
      message: "Extracting image...",
    });
    await el.updateComplete;
    const layout = el.shadowRoot!.querySelector("install-progress")!;
    await layout.updateComplete;
    expect(
      layout.shadowRoot!.querySelector(".bytes-info")!.textContent
    ).to.equal("25 KB / 100 KB compressed");
    const bar = layout.shadowRoot!.querySelector("progress-bar")!;
    await bar.updateComplete;
    expect(bar.indeterminate).to.be.false;
    expect(bar.progress).to.equal(25);
  });

  it("reports a missing drive or device config to the app shell", async () => {
    // The app shell only shows Cancel and Try again after flash-error
    let errorEvents = 0;
    const onError = () => errorEvents++;
    document.addEventListener("flash-error", onError);

    try {
      const el = fixtureSync<ProgressView>(
        html`<progress-view></progress-view>`
      );
      await el.updateComplete;

      expect(el.hasError).to.be.true;
      expect(
        el.shadowRoot!.querySelector("install-progress")!.shadowRoot!
          .textContent
      ).to.contain("Missing drive or device configuration");
      expect(errorEvents).to.equal(1);
    } finally {
      document.removeEventListener("flash-error", onError);
    }
  });

  for (const missing of ["drive", "deviceConfig"] as const) {
    it(`does not call IPC when only ${missing} is missing`, async () => {
      if (missing === "drive") {
        wizardState.setSelection("deviceConfig", MOCK_MANIFEST.devices[0].haos);
      } else {
        storeDriveSelection(MOCK_BLOCK_DEVICES[0]);
      }
      let calls = 0;
      mockTauriIpc(() => {
        calls++;
      });
      const el = fixtureSync<ProgressView>(
        html`<progress-view></progress-view>`
      );
      await settle();
      expect(el.hasError).to.be.true;
      expect(
        el
          .shadowRoot!.querySelector("install-progress")!
          .shadowRoot!.querySelector(".error-message")!.textContent
      ).to.equal("Missing drive or device configuration");
      expect(calls).to.equal(0);
    });
  }
});
