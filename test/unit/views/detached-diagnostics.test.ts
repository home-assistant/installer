import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import type { LitElement } from "lit";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import "../../../src/views/ha-hardware/device-selection-view.js";
import "../../../src/views/minipc/architecture-selection-view.js";
import "../../../src/views/proxmox/proxmox-configure-view.js";
import "../../../src/views/proxmox/proxmox-connect-view.js";
import "../../../src/views/sbc/device-selection-view.js";
import "../../../src/views/utm/utm-check-view.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import {
  getDiagnostics,
  InstallDiagnostics,
} from "../../../src/utils/diagnostics.js";
import {
  deferred,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../tauri-ipc.js";

const scenarios = [
  {
    name: "HA hardware manifest",
    command: "get_manifest",
    flow: "flash",
    view: html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`,
  },
  {
    name: "mini PC manifest",
    command: "get_manifest",
    flow: "flash",
    view: html`<minipc-architecture-selection-view></minipc-architecture-selection-view>`,
  },
  {
    name: "Proxmox nodes",
    command: "proxmox_list_nodes",
    flow: "proxmox",
    view: html`<proxmox-configure-view></proxmox-configure-view>`,
  },
  {
    name: "Proxmox connection",
    command: "proxmox_connect",
    flow: "proxmox",
    view: html`<proxmox-connect-view></proxmox-connect-view>`,
  },
  {
    name: "SBC manifest",
    command: "get_manifest",
    flow: "flash",
    view: html`<device-selection-view></device-selection-view>`,
  },
  {
    name: "UTM status",
    command: "check_utm_status",
    flow: "utm",
    view: html`<utm-check-view></utm-check-view>`,
  },
] as const;

describe("view diagnostic request ownership", () => {
  afterEach(() => {
    restoreTauriIpc();
    wizardState.reset();
  });

  for (const scenario of scenarios) {
    for (const detached of [false, true]) {
      it(`${scenario.name} ${detached ? "preserves newer diagnostics after detachment" : "records an attached failure"}`, async () => {
        const request = deferred<never>();
        const events: unknown[] = [];
        let requested = false;
        mockTauriIpc(
          (command, args) => {
            if (command === scenario.command) {
              requested = true;
              return request.promise;
            }
            if (command === "proxmox_get_next_vm_id") return 100;
            // A trusted certificate: no confirmation before the login
            if (command === "proxmox_certificate_fingerprint") return null;
            if (command === "log_frontend_event") {
              events.push(args);
              return;
            }
            if (command === "get_diagnostics") return {};
            throw new Error(command);
          },
          { includeLogs: true }
        );
        wizardState.startFlow(
          scenario.flow === "flash"
            ? "sbc"
            : scenario.flow === "utm"
              ? "vm"
              : scenario.flow
        );
        if (scenario.command === "proxmox_list_nodes") {
          wizardState.setSelection("proxmoxSession", {
            server_url: "https://192.0.2.1:8006",
            ticket: "test-ticket",
            csrf_token: "test-csrf",
          });
        }
        const view = await fixture<LitElement>(scenario.view);
        let connecting: Promise<boolean> | undefined;
        if (scenario.command === "proxmox_connect") {
          for (const [id, value] of [
            ["server-url", "https://192.0.2.1:8006"],
            ["password", "test-password"],
          ]) {
            const input = view.shadowRoot!.querySelector<WaInput>(
              `wa-input[input-id="${id}"]`
            )!;
            await input.updateComplete;
            input.value = value;
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
          connecting = (
            view as LitElement & { connect(): Promise<boolean> }
          ).connect();
        }
        await waitUntil(() => requested, "view did not start its request");

        if (detached) view.remove();
        const current = new InstallDiagnostics("application");
        current.advance("frontend");
        current.fail("Timed out in the active screen");
        const before = await getDiagnostics();
        const previousEvents = [...events];

        request.reject("Permission denied for stale-private-data");
        await connecting;
        await settle();
        const after = await getDiagnostics();
        if (detached) {
          expect(after.context).to.deep.equal(before.context);
          expect(events).to.deep.equal(previousEvents);
        } else {
          expect(after.context).to.deep.equal({
            flow: scenario.flow,
            stage:
              scenario.command === "proxmox_connect"
                ? "connecting"
                : "preparing",
            error: "permission_denied",
          });
          expect(events.length).to.be.greaterThan(previousEvents.length);
        }
        expect(JSON.stringify(events)).not.to.contain("stale-private-data");
      });
    }
  }
});
