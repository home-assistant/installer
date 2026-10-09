import { expect, fixtureSync, html } from "@open-wc/testing";
import type { Channel } from "@tauri-apps/api/core";
import type { FlashProgress } from "../../../src/api/types.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import "../../../src/views/proxmox/proxmox-progress-view.js";
import { mockTauriIpc, restoreTauriIpc } from "../tauri-ipc.js";

describe("VM writing progress", () => {
  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  for (const flow of ["proxmox"] as const) {
    it(`renders ${flow} byte progress and falls back when the total is unknown`, async () => {
      wizardState.startFlow("proxmox");
      wizardState.setSelection("proxmoxSession", {
        server_url: "https://pve:8006",
        ticket: "test",
        csrf_token: "test",
      });
      let channel!: Channel<FlashProgress>;
      mockTauriIpc((cmd, args) => {
        if (cmd === "proxmox_create_vm") {
          channel = (args as { progressChannel: Channel<FlashProgress> })
            .progressChannel;
          return new Promise(() => {});
        }
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });
      const el = fixtureSync(
        html`<proxmox-progress-view></proxmox-progress-view>`
      );
      const view = el as HTMLElement & { updateComplete: Promise<boolean> };
      await view.updateComplete;

      // The shared progress layout renders the bar and counters in its own shadow root
      const layout = async () => {
        await view.updateComplete;
        const progress = el.shadowRoot!.querySelector("install-progress")!;
        await progress.updateComplete;
        return progress.shadowRoot!;
      };

      for (const progress of [0, 25, 75, 100]) {
        channel.onmessage({
          stage: "uploading",
          progress,
          bytes_processed: progress * 1000,
          total_bytes: 100_000,
          message: "Processing image",
        });
        const root = await layout();
        const bar = root.querySelector("progress-bar")!;
        await bar.updateComplete;
        expect(bar.indeterminate).to.be.false;
        expect(bar.progress).to.equal(progress);
        expect(root.querySelector(".percentage")!.textContent).to.equal(
          `${progress}%`
        );
        expect(root.querySelector(".bytes-info")!.textContent).to.contain(
          " / 100 KB"
        );
      }

      channel.onmessage({
        stage: "uploading",
        progress: 50,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Processing image",
      });
      const root = await layout();
      const bar = root.querySelector("progress-bar")!;
      await bar.updateComplete;
      expect(bar.indeterminate).to.be.true;
      for (const selector of [".percentage", ".bytes-info", ".speed", ".eta"]) {
        expect(root.querySelector(selector)!.textContent).to.equal("");
      }
    });
  }
});
