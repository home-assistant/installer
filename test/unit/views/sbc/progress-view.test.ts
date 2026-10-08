import { expect, fixtureSync, html } from "@open-wc/testing";
import type { Channel } from "@tauri-apps/api/core";
import type { FlashProgress } from "../../../../src/api/types.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/sbc/progress-view.js";
import type { ProgressView } from "../../../../src/views/sbc/progress-view.js";
import { mockTauriIpc, restoreTauriIpc } from "../../tauri-ipc.js";

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
});
