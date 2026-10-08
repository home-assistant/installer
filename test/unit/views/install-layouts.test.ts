import { expect, fixtureSync, html } from "@open-wc/testing";
import type { Channel } from "@tauri-apps/api/core";
import type { FlashProgress } from "../../../src/api/types.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import "../../../src/views/sbc/progress-view.js";
import "../../../src/views/utm/utm-progress-view.js";
import "../../../src/views/proxmox/proxmox-progress-view.js";
import "../../../src/views/sbc/success-view.js";
import "../../../src/views/utm/utm-success-view.js";
import "../../../src/views/proxmox/proxmox-success-view.js";
import { mockTauriIpc, restoreTauriIpc, settle } from "../tauri-ipc.js";

describe("shared install layouts", () => {
  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  for (const flow of ["sbc", "utm", "proxmox"] as const) {
    it(`keeps ${flow} progress, error and retry connected to its pipeline`, async () => {
      wizardState.startFlow(flow === "utm" ? "vm" : flow);
      wizardState.setSelection("drive", "/dev/test-only");
      wizardState.setSelection("deviceConfig", {
        board: "rpi5-64",
        download_url: "https://example.test/image.xz",
        minimum_storage_bytes: 16_000_000_000,
        recommended_storage_bytes: 32_000_000_000,
      });
      wizardState.setSelection("proxmoxSession", {
        server_url: "https://pve:8006",
        ticket: "test",
        csrf_token: "test",
      });
      let channel!: Channel<FlashProgress>;
      let reject!: (reason: Error) => void;
      let attempts = 0;
      mockTauriIpc((cmd, args) => {
        if (
          ["flash_image", "download_utm_image", "proxmox_create_vm"].includes(
            cmd
          )
        ) {
          attempts++;
          channel = (args as { progressChannel: Channel<FlashProgress> })
            .progressChannel;
          return new Promise((_resolve, fail) => {
            reject = fail;
          });
        }
        throw new Error(`Unexpected command: ${cmd}`);
      });
      const view = fixtureSync<HTMLElement & { retry(): void }>(
        flow === "sbc"
          ? html`<progress-view></progress-view>`
          : flow === "utm"
            ? html`<utm-progress-view></utm-progress-view>`
            : html`<proxmox-progress-view></proxmox-progress-view>`
      );
      await settle();
      const layout = view.shadowRoot!.querySelector("install-progress")!;
      if (flow !== "sbc") {
        expect(
          layout
            .shadowRoot!.querySelector(".stage:last-child .stage-label")!
            .textContent?.trim()
        ).to.equal("Installing latest Home Assistant");
      }
      for (const stage of ["downloading", "extracting"] as const) {
        for (const total of [102400, 0]) {
          channel.onmessage({
            stage,
            progress: 50,
            bytes_processed: 51200,
            total_bytes: total,
            message: "Processing image",
          });
          await settle();
          expect(
            layout.shadowRoot!.querySelector("progress-bar")!.indeterminate
          ).to.equal(
            flow === "sbc" ? total === 0 : stage === "extracting" && total === 0
          );
          // Extraction is measurable once the compressed archive size is known
          expect(
            layout.shadowRoot!.querySelector(".percentage")?.textContent ?? ""
          ).to.equal(
            (flow === "sbc" ? total > 0 : stage === "downloading" || total > 0)
              ? "50%"
              : ""
          );
          expect(
            layout.shadowRoot!.querySelectorAll(".stage-dot.complete").length
          ).to.equal(stage === "extracting" ? 1 : 0);
          expect(
            layout.shadowRoot!.querySelectorAll(".stage-dot.active").length
          ).to.equal(1);
        }
      }
      let errors = 0;
      view.addEventListener(
        flow === "sbc" ? "flash-error" : "install-error",
        () => errors++
      );
      reject(new Error("Test failure"));
      await settle();
      expect(errors).to.equal(1);
      expect(
        layout.shadowRoot!.querySelector(".error-message")!.textContent
      ).to.equal("Test failure");
      view.retry();
      await settle();
      expect(attempts).to.equal(2);
      expect(layout.error).to.equal(null);
      expect(layout.shadowRoot!.querySelector("progress-bar")).to.exist;
    });

    it(`preserves ${flow} next steps and external link actions`, async () => {
      wizardState.startFlow(flow === "utm" ? "vm" : flow);
      wizardState.setSelection("deviceName", "Raspberry Pi 5");
      wizardState.setSelection("vmName", "My home");
      wizardState.setSelection("proxmoxVmId", 123);
      wizardState.setSelection("proxmoxNode", "pve-test");
      wizardState.setSelection("ipAddress", "192.0.2.50");
      const opened: string[] = [];
      mockTauriIpc((cmd, args) => {
        expect(cmd).to.equal("plugin:opener|open_url");
        opened.push((args as { url: string }).url);
      });
      const view = fixtureSync(
        flow === "sbc"
          ? html`<success-view></success-view>`
          : flow === "utm"
            ? html`<utm-success-view></utm-success-view>`
            : html`<proxmox-success-view></proxmox-success-view>`
      );
      await settle();
      const layout = view.shadowRoot!.querySelector("install-success")!;
      const content = layout.shadowRoot!;
      expect(content.querySelectorAll(".step-item").length).to.equal(
        flow === "sbc" ? 4 : 3
      );
      expect(content.querySelector(".subtitle")!.textContent).to.contain(
        flow === "sbc" ? "Raspberry Pi 5" : "My home"
      );
      if (flow === "proxmox") {
        expect(content.querySelector(".subtitle")!.textContent).to.contain(
          "VM 123"
        );
        expect(content.querySelector(".subtitle")!.textContent).to.contain(
          "pve-test"
        );
      }
      const link = content.querySelector<HTMLAnchorElement>(".step-text a")!;
      link.click();
      for (const appLink of content.querySelectorAll<HTMLAnchorElement>(
        ".app-link"
      ))
        appLink.click();
      await settle();
      expect(opened).to.deep.equal([
        flow === "sbc" ? "http://homeassistant.local" : "http://192.0.2.50",
        "https://apps.apple.com/app/home-assistant/id1099568401",
        "https://play.google.com/store/apps/details?id=io.homeassistant.companion.android",
      ]);
    });
  }
});
