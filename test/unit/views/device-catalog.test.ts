import { expect, fixture, fixtureCleanup, waitUntil } from "@open-wc/testing";
import "../../../src/views/sbc/device-selection-view.js";
import "../../../src/views/ha-hardware/device-selection-view.js";
import "../../../src/views/minipc/architecture-selection-view.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import { MOCK_MANIFEST } from "../../../src/api/mock-data.js";
import {
  deferred,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../tauri-ipc.js";
import type { DeviceManifest } from "../../../src/api/types.js";

describe("runtime device catalog selections", () => {
  afterEach(() => {
    fixtureCleanup();
    restoreTauriIpc();
    wizardState.reset();
  });

  // The Blue is the Home Assistant hardware that depends on the catalog: it
  // is offered under its own id, with the catalog's ODROID-N2 board.
  for (const [tag, board, deviceId] of [
    ["device-selection-view", "rpi5-64", undefined],
    ["ha-hardware-device-selection-view", "odroid-n2", "ha-blue"],
    ["minipc-architecture-selection-view", "generic-x86-64", undefined],
  ]) {
    const catalogDevice = MOCK_MANIFEST.devices.find(
      (device) => device.haos.board === board
    )!;
    const selected = { ...catalogDevice, id: deviceId ?? catalogDevice.id };
    for (const available of [true, false]) {
      it(`${tag} ${available ? "keeps" : "clears"} the previous selection after a successful refresh`, async () => {
        wizardState.setSelection("device", selected.id);
        wizardState.setSelection("deviceConfig", selected.haos);
        wizardState.setSelection("drive", "keep-this-drive");
        wizardState.setSelection("deviceCatalogReady", true);
        const pending = deferred<DeviceManifest>();
        mockTauriIpc(() => pending.promise);
        await fixture(`<${tag}></${tag}>`);
        expect(wizardState.getState().selections.deviceCatalogReady).to.equal(
          false
        );
        expect(wizardState.getState().selections.device).to.equal(selected.id);
        pending.resolve({
          ...MOCK_MANIFEST,
          devices: available ? [catalogDevice] : [],
        });
        await waitUntil(
          () => wizardState.getState().selections.deviceCatalogReady === true
        );
        const selections = wizardState.getState().selections;
        expect(selections.device).to.equal(available ? selected.id : undefined);
        expect(selections.deviceConfig).to.deep.equal(
          available ? selected.haos : undefined
        );
        expect(selections.drive).to.equal("keep-this-drive");
      });
    }

    it(`${tag} remains unready after a failed refresh without discarding the saved choice`, async () => {
      wizardState.setSelection("device", selected.id);
      wizardState.setSelection("deviceConfig", selected.haos);
      wizardState.setSelection("deviceCatalogReady", true);
      mockTauriIpc(() => Promise.reject("Catalog unavailable"));
      const view = await fixture(`<${tag}></${tag}>`);
      await waitUntil(() => !!view.shadowRoot!.querySelector(".error"));
      expect(wizardState.getState().selections.deviceCatalogReady).to.equal(
        false
      );
      expect(wizardState.getState().selections.device).to.equal(selected.id);
    });

    it(`${tag} ignores a catalog response after leaving the view`, async () => {
      wizardState.setSelection("deviceCatalogReady", false);
      const pending = deferred<DeviceManifest>();
      mockTauriIpc(() => pending.promise);
      const view = await fixture(`<${tag}></${tag}>`);
      view.remove();
      pending.resolve(MOCK_MANIFEST);
      await settle();
      expect(wizardState.getState().selections.deviceCatalogReady).to.equal(
        false
      );
    });
  }
});
