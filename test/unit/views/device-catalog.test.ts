import { expect, fixture, fixtureCleanup, waitUntil } from "@open-wc/testing";
import "../../../src/views/sbc/device-selection-view.js";
import "../../../src/views/ha-hardware/device-selection-view.js";
import "../../../src/views/minipc/architecture-selection-view.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import { MOCK_MANIFEST } from "../../../src/api/mock-data.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../tauri-ipc.js";
import type { DeviceManifest } from "../../../src/api/types.js";
import type { CardButton } from "../../../src/components/card-button.js";

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

  // Two devices each picker offers
  for (const [tag, first, second] of [
    ["device-selection-view", "rpi5", "rpi4"],
    ["ha-hardware-device-selection-view", "ha-green", "ha-blue"],
    ["minipc-architecture-selection-view", "generic-x86-64", "generic-aarch64"],
  ]) {
    /** Answer the catalog with `manifest`, and no Mac with UTM */
    function mockCatalog(manifest: () => unknown) {
      mockTauriIpc((cmd) => (cmd === "get_manifest" ? manifest() : false));
    }

    /** The card of the device with id `value`, once the list is in */
    function card(view: Element, value: string) {
      return [
        ...view.shadowRoot!.querySelectorAll<CardButton>(
          "device-card, option-card"
        ),
      ].find((card) => card.value === value);
    }

    it(`${tag} keeps its heading while the catalog loads and when it fails`, async () => {
      const pending = deferred<DeviceManifest>();
      mockCatalog(() => pending.promise);
      const view = await fixture(`<${tag}></${tag}>`);
      const root = view.shadowRoot!;
      const heading = root.querySelector("h2");
      expect(heading).to.exist;
      expect(root.querySelector(".loading")).to.exist;

      pending.reject(ipcError("network", "offline", true));
      await waitUntil(() => root.querySelector(".error"), "never failed");
      expect(root.querySelector("h2") === heading).to.be.true;
    });

    it(`${tag} continues from its heading once Try again brings the list`, async () => {
      let attempts = 0;
      mockCatalog(() =>
        ++attempts === 1
          ? Promise.reject(ipcError("network", "offline", true))
          : MOCK_MANIFEST
      );
      const view = await fixture(`<${tag}></${tag}>`);
      const root = view.shadowRoot!;
      await waitUntil(() => root.querySelector(".error wa-button"));
      const retry = root.querySelector<HTMLElement>(".error wa-button")!;
      retry.focus();
      retry.click();

      await waitUntil(
        () => root.querySelector('[role="group"]'),
        "catalog never reloaded"
      );
      await waitUntil(
        () => root.activeElement === root.querySelector("h2"),
        "the focus never went on from the heading"
      );
    });

    it(`${tag} keeps the drive for the same device and drops it for another`, async () => {
      wizardState.setSelection("device", first);
      wizardState.setSelection("drive", "keep-this-drive");
      mockCatalog(() => MOCK_MANIFEST);
      const view = await fixture(`<${tag}></${tag}>`);
      await waitUntil(() => card(view, first));

      card(view, first)!.click();
      expect(wizardState.getState().selections.drive).to.equal(
        "keep-this-drive"
      );

      card(view, second)!.click();
      const selections = wizardState.getState().selections;
      expect(selections.device).to.equal(second);
      expect(selections.drive).to.equal(undefined);
    });

    it(`${tag} goes on once a device is picked, the one chosen before too`, async () => {
      wizardState.setSelection("device", first);
      mockCatalog(() => MOCK_MANIFEST);
      const view = await fixture(`<${tag}></${tag}>`);
      await waitUntil(() => card(view, first));
      const picked: (string | undefined)[] = [];
      view.addEventListener("wizard-next", () => {
        picked.push(wizardState.getState().selections.device);
      });

      card(view, first)!.click();
      card(view, second)!
        .shadowRoot!.querySelector('[role="button"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(picked).to.deep.equal([first, second]);
    });
  }
});
