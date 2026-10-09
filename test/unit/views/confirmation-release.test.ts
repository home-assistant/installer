import {
  expect,
  fixture,
  fixtureCleanup,
  html,
  waitUntil,
} from "@open-wc/testing";
import "../../../src/views/sbc/confirmation-view.js";
import "../../../src/views/utm/utm-confirm-view.js";
import "../../../src/views/proxmox/proxmox-confirm-view.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import { mockTauriIpc, restoreTauriIpc } from "../tauri-ipc.js";

describe("confirmation release selection", () => {
  afterEach(() => {
    fixtureCleanup();
    restoreTauriIpc();
    wizardState.reset();
  });

  for (const board of ["rpi5-64", "odroid-n2", "green", "generic-x86-64"]) {
    it(`shows the release for selected board ${board}`, async () => {
      wizardState.setSelection("deviceConfig", {
        board,
        download_url: "unused",
        minimum_storage_bytes: 16_000_000_000,
        recommended_storage_bytes: 32_000_000_000,
      });
      mockTauriIpc((command, args) => {
        expect(command).to.equal("get_haos_release");
        expect(args).to.have.property("board", board);
        return { version: "18.2", images: [] };
      });
      const view = await fixture(html`<confirmation-view></confirmation-view>`);
      await waitUntil(() => view.shadowRoot!.textContent!.includes("18.2"));
    });
  }

  it("does not show an unrelated global release without a selected board", async () => {
    let calls = 0;
    mockTauriIpc(() => {
      calls++;
      throw new Error("must not request global latest");
    });
    const view = await fixture(html`<confirmation-view></confirmation-view>`);
    await waitUntil(() =>
      view.shadowRoot!.textContent!.includes("Version Unknown")
    );
    expect(calls).to.equal(0);
  });

  it("shows the Proxmox ova board release", async () => {
    mockTauriIpc((command, args) => {
      expect(command).to.equal("get_haos_release");
      expect(args).to.have.property("board", "ova");
      return { version: "18.1", images: [] };
    });
    const view = await fixture(
      html`<proxmox-confirm-view></proxmox-confirm-view>`
    );
    await waitUntil(() => view.shadowRoot!.textContent!.includes("18.1"));
  });

  it("asks the backend for the UTM download architecture's release", async () => {
    mockTauriIpc((command) => {
      expect(command).to.equal("get_utm_haos_release");
      return { version: "18.0", images: [] };
    });
    const view = await fixture(html`<utm-confirm-view></utm-confirm-view>`);
    await waitUntil(() => view.shadowRoot!.textContent!.includes("18.0"));
  });

  it("keeps the existing unknown-version state when lookup fails", async () => {
    wizardState.setSelection("deviceConfig", {
      board: "rpi5-64",
      download_url: "unused",
      minimum_storage_bytes: 16_000_000_000,
      recommended_storage_bytes: 32_000_000_000,
    });
    mockTauriIpc(() => Promise.reject("Release lookup failed"));
    const view = await fixture(html`<confirmation-view></confirmation-view>`);
    await waitUntil(() =>
      view.shadowRoot!.textContent!.includes("Version Unknown")
    );
  });
});
