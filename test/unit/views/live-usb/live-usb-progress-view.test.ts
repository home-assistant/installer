import { expect, fixtureSync, html } from "@open-wc/testing";
import type { Channel } from "@tauri-apps/api/core";
import type { FlashProgress } from "../../../../src/api/types.js";
import { MOCK_BLOCK_DEVICES } from "../../../../src/api/mock-data.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import { storeDriveSelection } from "../../../../src/utils/drive-selection.js";
import "../../../../src/views/live-usb/live-usb-progress-view.js";
import type { LiveUsbProgressView } from "../../../../src/views/live-usb/live-usb-progress-view.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

interface Call {
  cmd: string;
  args: Record<string, unknown> & { progressChannel: Channel<FlashProgress> };
  result: ReturnType<typeof deferred<unknown>>;
}

function mockCommands(): Call[] {
  const calls: Call[] = [];
  mockTauriIpc((cmd, args) => {
    const result = deferred<unknown>();
    calls.push({ cmd, args: args as Call["args"], result });
    return result.promise;
  });
  return calls;
}

describe("live-usb-progress-view", () => {
  beforeEach(() => {
    wizardState.startFlow("minipc");
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  it("writes the stick to the selected drive and reports completion", async () => {
    wizardState.setSelection("liveMedia", "usb");
    storeDriveSelection(MOCK_BLOCK_DEVICES[0]);
    const calls = mockCommands();
    const el = fixtureSync<LiveUsbProgressView>(
      html`<live-usb-progress-view></live-usb-progress-view>`
    );
    let completed = 0;
    el.addEventListener("flash-complete", () => completed++);
    await settle();

    expect(calls).to.have.length(1);
    expect(calls[0].cmd).to.equal("create_live_usb");
    expect(calls[0].args.deviceId).to.equal(MOCK_BLOCK_DEVICES[0].id);
    expect(calls[0].args.expectedDevice).to.deep.equal({
      size: MOCK_BLOCK_DEVICES[0].size,
      model: MOCK_BLOCK_DEVICES[0].model,
      vendor: MOCK_BLOCK_DEVICES[0].vendor,
      serial: MOCK_BLOCK_DEVICES[0].serial,
    });

    calls[0].args.progressChannel.onmessage({
      stage: "writing",
      progress: 40,
      bytes_processed: 400,
      total_bytes: 1000,
      message: "",
    });
    await settle();
    expect(
      el
        .shadowRoot!.querySelector("install-progress")!
        .shadowRoot!.querySelector("progress-bar")!.progress
    ).to.equal(40);

    // Windows and Linux writers finish with this stage after verifying
    calls[0].args.progressChannel.onmessage({
      stage: "finalizing",
      progress: 100,
      bytes_processed: 1000,
      total_bytes: 1000,
      message: "",
    });
    await settle();
    expect(
      el.shadowRoot!.querySelector("install-progress")!.stageTitle
    ).to.equal("Finalizing");

    calls[0].result.resolve(undefined);
    await settle();
    expect(completed).to.equal(1);
  });

  it("saves the ISO with the chosen location and remembers the saved path", async () => {
    wizardState.setSelection("liveMedia", "iso");
    wizardState.setSelection("liveIsoFolder", "/home/me");
    wizardState.setSelection("liveIsoName", "stick.iso");
    wizardState.setSelection("liveIsoOverwrite", true);
    const calls = mockCommands();
    fixtureSync(html`<live-usb-progress-view></live-usb-progress-view>`);
    await settle();

    expect(calls[0].cmd).to.equal("save_live_iso");
    expect(calls[0].args).to.include({
      folder: "/home/me",
      fileName: "stick.iso",
      overwrite: true,
    });

    calls[0].result.resolve("/home/me/stick.iso");
    await settle();
    expect(wizardState.getState().selections.liveIsoPath).to.equal(
      "/home/me/stick.iso"
    );
  });

  it("shows a backend error and reports whether it can be retried", async () => {
    wizardState.setSelection("liveMedia", "usb");
    storeDriveSelection(MOCK_BLOCK_DEVICES[0]);
    const calls = mockCommands();
    const el = fixtureSync<LiveUsbProgressView>(
      html`<live-usb-progress-view></live-usb-progress-view>`
    );
    const errors: boolean[] = [];
    el.addEventListener("flash-error", (event) =>
      errors.push(
        (event as CustomEvent<{ retryable: boolean }>).detail.retryable
      )
    );
    await settle();

    calls[0].result.reject(
      ipcError("device_busy", "The drive is in use.", true)
    );
    await settle();
    expect(errors).to.deep.equal([true]);
    expect(el.shadowRoot!.querySelector("install-progress")!.error).to.contain(
      "The drive is in use"
    );
  });
});
