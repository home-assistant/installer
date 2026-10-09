import { expect, fixtureSync, html, waitUntil } from "@open-wc/testing";
import { wizardState } from "../../../src/state/wizard-state.js";
import { MOCK_BLOCK_DEVICES } from "../../../src/api/mock-data.js";
import { storeDriveSelection } from "../../../src/utils/drive-selection.js";
import { ipcError, mockTauriIpc, restoreTauriIpc } from "../tauri-ipc.js";
import "../../../src/components/app-shell.js";
import "../../../src/views/ha-hardware/device-selection-view.js";

describe("structured IPC errors in views", () => {
  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  for (const flow of ["vm", "proxmox"] as const) {
    it(`${flow} preserves structured errors and prevents unsafe direct retry`, async () => {
      wizardState.startFlow(flow);
      wizardState.setSelection("proxmoxSession", {
        server_url: "https://example.test",
        ticket: "fixture",
        csrf_token: "fixture",
      });
      let attempts = 0;
      mockTauriIpc((cmd) => {
        if (cmd === "download_utm_image") return "/tmp/fixture.qcow2";
        if (cmd === "discard_utm_image") return;
        // Only the creation counts; the error's diagnostics also use IPC
        if (cmd === "create_utm_vm" || cmd === "proxmox_create_vm") attempts++;
        return Promise.reject(
          ipcError(
            flow === "vm" ? "utm_operation_uncertain" : "proxmox_api",
            "Check UTM before removing the retained source"
          )
        );
      });
      const el = document.createElement(
        flow === "vm" ? "utm-progress-view" : "proxmox-progress-view"
      ) as HTMLElement & { retry(): void };
      fixtureSync(html`<div>${el}</div>`);
      // The shared progress layout renders the error and its help
      const layout = () =>
        el.shadowRoot?.querySelector("install-progress")?.shadowRoot;
      await waitUntil(() => !!layout()?.querySelector(".error-help"));
      expect(layout()!.textContent).to.contain(
        flow === "vm" ? "retained source" : "account permissions"
      );
      el.retry();
      expect(attempts).to.equal(1);
    });
  }

  it("connection view maps a JSON rejection without leaking its raw message", async () => {
    wizardState.startFlow("proxmox");
    mockTauriIpc(() => Promise.reject(ipcError("proxmox_api", "secret")));
    const el = fixtureSync(
      html`<proxmox-connect-view></proxmox-connect-view>`
    ) as HTMLElement & {
      _serverUrl: string;
      _username: string;
      _password: string;
      connect(): Promise<boolean>;
      updateComplete: Promise<unknown>;
    };
    el._serverUrl = "https://example.test";
    el._username = "fixture";
    el._password = "fixture";
    expect(await el.connect()).to.be.false;
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).to.contain("account permissions");
    expect(el.shadowRoot!.textContent).not.to.contain("secret");
    expect(el.shadowRoot!.querySelectorAll(".error-help a").length).to.equal(1);
  });

  for (const tag of [
    "device-selection-view",
    "ha-hardware-device-selection-view",
    "minipc-architecture-selection-view",
    "drive-selection-view",
    "utm-check-view",
    "proxmox-configure-view",
  ]) {
    for (const retryable of [false, true]) {
      it(`${tag} shows JSON errors and ${retryable ? "allows" : "hides"} retry`, async () => {
        wizardState.startFlow("proxmox");
        wizardState.setSelection("proxmoxSession", {
          server_url: "https://example.test",
          ticket: "fixture",
          csrf_token: "fixture",
        });
        mockTauriIpc(() =>
          Promise.reject(
            ipcError(
              retryable ? "permission_denied" : "unsupported_platform",
              "Run as administrator",
              retryable
            )
          )
        );
        const el = document.createElement(tag) as HTMLElement & {
          updateComplete: Promise<unknown>;
        };
        fixtureSync(html`<div>${el}</div>`);
        await waitUntil(() => !!el.shadowRoot?.querySelector(".error-help"));
        expect(el.shadowRoot!.textContent).to.contain(
          retryable
            ? "Run as administrator"
            : "Choose another installation method"
        );
        const retry = [...el.shadowRoot!.querySelectorAll("wa-button")].find(
          (button) => button.textContent?.includes("Try again")
        );
        expect(!!retry && !retry.hasAttribute("hidden")).to.equal(retryable);
        if (retry && !retryable)
          expect(retry.getBoundingClientRect().width).to.equal(0);
        // Installation help, plus reporting through the diagnostics dialog
        expect(
          el.shadowRoot!.querySelectorAll(".error-help a").length
        ).to.equal(1);
        expect(el.shadowRoot!.querySelector(".error-help diagnostics-actions"))
          .to.exist;
      });
    }
  }

  for (const retryable of [false, true]) {
    it(`shell ${retryable ? "offers" : "blocks"} retry after a structured flash failure`, async () => {
      let attempts = 0;
      mockTauriIpc((cmd) => {
        if (cmd === "flash_image") {
          attempts++;
          return Promise.reject(
            ipcError(
              retryable ? "network" : "image_too_large",
              "backend text",
              retryable,
              { image_size: 2 ** 32, drive_size: 2 ** 31 }
            )
          );
        }
        return new Promise(() => {});
      });
      const app = fixtureSync(html`<app-shell></app-shell>`) as HTMLElement & {
        updateComplete: Promise<unknown>;
        _currentView: string;
      };
      wizardState.startFlow("sbc");
      wizardState.setSelection("deviceConfig", {
        board: "rpi5-64",
        download_url: "https://example.test/image",
        minimum_storage_bytes: 16_000_000_000,
        recommended_storage_bytes: 32_000_000_000,
      });
      storeDriveSelection(MOCK_BLOCK_DEVICES[0]);
      wizardState.goToStep(
        wizardState.getState().steps.findIndex((step) => step.id === "flash")
      );
      app._currentView = "wizard";
      await app.updateComplete;
      const shell = app.shadowRoot!.querySelector(
        "wizard-shell"
      ) as HTMLElement & { hideNext: boolean; hideFooter: boolean };
      await waitUntil(() => !shell.hideFooter);
      expect(shell.hideNext).to.equal(false);
      shell.dispatchEvent(
        new CustomEvent("wizard-next", { bubbles: true, composed: true })
      );
      await app.updateComplete;
      expect(attempts).to.equal(retryable ? 2 : 1);
      if (!retryable) expect(wizardState.currentStep?.id).to.equal("drive");
      shell.remove();
    });
  }
});
