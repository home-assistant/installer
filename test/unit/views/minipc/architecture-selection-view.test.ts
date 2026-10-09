import {
  expect,
  fixture,
  fixtureSync,
  html,
  waitUntil,
} from "@open-wc/testing";
import "../../../../src/views/minipc/architecture-selection-view.js";
import type { MiniPCArchitectureSelectionView } from "../../../../src/views/minipc/architecture-selection-view.js";
import { MOCK_MANIFEST } from "../../../../src/api/mock-data.js";
import type { DeviceManifest } from "../../../../src/api/types.js";
import {
  deferred,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";
import { wizardState } from "../../../../src/state/wizard-state.js";

describe("minipc-architecture-selection-view focus", () => {
  afterEach(() => {
    restoreTauriIpc();
    wizardState.reset();
  });

  it("hands lost focus to the choices and does not refocus on ordinary updates", async () => {
    const el = await fixture<MiniPCArchitectureSelectionView>(
      html`<minipc-architecture-selection-view></minipc-architecture-selection-view>`
    );
    await waitUntil(() => !!el.shadowRoot!.activeElement);
    // The shared view policy focuses the new view's heading first
    expect(el.shadowRoot!.activeElement!.tagName).to.equal("H2");
    const button = fixtureSync<HTMLButtonElement>(
      html`<button>Cancel</button>`
    );
    button.focus();
    el.requestUpdate();
    await el.updateComplete;
    expect(document.activeElement).to.equal(button);
  });

  it("focuses the retry control if loading fails", async () => {
    mockTauriIpc(() => Promise.reject("Manifest unavailable"));
    const el = await fixture<MiniPCArchitectureSelectionView>(
      html`<minipc-architecture-selection-view></minipc-architecture-selection-view>`
    );
    await waitUntil(() => !!el.shadowRoot!.activeElement);
    // A loading failure focuses its alert, next to the retry control
    expect(el.shadowRoot!.activeElement!.getAttribute("role")).to.equal(
      "alert"
    );
  });

  it("does not steal focus moved elsewhere while the manifest loads", async () => {
    const manifest = deferred<DeviceManifest>();
    mockTauriIpc((cmd) => {
      if (cmd === "get_manifest") return manifest.promise;
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = await fixture<MiniPCArchitectureSelectionView>(
      html`<minipc-architecture-selection-view></minipc-architecture-selection-view>`
    );
    const button = fixtureSync<HTMLButtonElement>(
      html`<button>Cancel</button>`
    );
    button.focus();
    manifest.resolve(MOCK_MANIFEST);
    await settle();
    await el.updateComplete;
    expect(el.shadowRoot!.querySelectorAll("wa-radio")).to.have.length(2);
    expect(document.activeElement).to.equal(button);
  });
});
