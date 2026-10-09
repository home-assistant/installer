import { expect, fixtureSync, html } from "@open-wc/testing";
import {
  MOCK_BLOCK_DEVICES,
  MOCK_HAOS_RELEASE,
  MOCK_MANIFEST,
} from "../../../src/api/mock-data.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import { storeDriveSelection } from "../../../src/utils/drive-selection.js";
import "../../../src/views/sbc/confirmation-view.js";
import "../../../src/views/utm/utm-confirm-view.js";
import "../../../src/views/proxmox/proxmox-confirm-view.js";
import { mockTauriIpc, restoreTauriIpc, settle } from "../tauri-ipc.js";

describe("installation confirmation views", () => {
  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  for (const flow of ["sbc", "vm", "proxmox"] as const) {
    for (const failRelease of [false, true]) {
      it(`keeps ${flow} selections visible when release lookup ${failRelease ? "fails" : "succeeds"}`, async () => {
        wizardState.startFlow(flow);
        storeDriveSelection(MOCK_BLOCK_DEVICES[0]);
        wizardState.setSelection("deviceName", MOCK_MANIFEST.devices[0].name);
        wizardState.setSelection("deviceConfig", MOCK_MANIFEST.devices[0].haos);
        wizardState.setSelection("vmName", "Test Home Assistant");
        mockTauriIpc((cmd) => {
          // UTM asks for the release of the board its download will use
          expect(cmd).to.equal(
            flow === "vm" ? "get_utm_haos_release" : "get_haos_release"
          );
          return failRelease
            ? Promise.reject("Release unavailable")
            : MOCK_HAOS_RELEASE;
        });
        const el = fixtureSync(
          flow === "sbc"
            ? html`<confirmation-view></confirmation-view>`
            : flow === "vm"
              ? html`<utm-confirm-view></utm-confirm-view>`
              : html`<proxmox-confirm-view></proxmox-confirm-view>`
        );
        await settle();
        expect(el.shadowRoot!.textContent).to.contain(
          `Version ${failRelease ? "Unknown" : MOCK_HAOS_RELEASE.version}`
        );
        expect(el.shadowRoot!.textContent).to.contain(
          flow === "sbc" ? MOCK_MANIFEST.devices[0].name : "Test Home Assistant"
        );
        if (flow === "sbc") {
          expect(el.shadowRoot!.textContent).to.contain(
            MOCK_BLOCK_DEVICES[0].id
          );
          expect(el.shadowRoot!.textContent).to.contain(
            MOCK_BLOCK_DEVICES[0].name
          );
        }
      });
    }
  }
});
