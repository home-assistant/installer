import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import "../../../../src/views/sbc/device-selection-view.js";
import type { DeviceSelectionView } from "../../../../src/views/sbc/device-selection-view.js";
import type { DeviceCard } from "../../../../src/components/device-card.js";
import type { Device } from "../../../../src/api/index.js";
import { MOCK_MANIFEST } from "../../../../src/api/mock-data.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import { findByRole, fullA11ySnapshot } from "../../helpers/a11y.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
} from "../../tauri-ipc.js";

describe("device-selection-view", () => {
  afterEach(() => {
    restoreTauriIpc();
    wizardState.reset();
  });

  const tinkerBoard: Device = {
    ...MOCK_MANIFEST.devices[0],
    id: "tinker",
    name: "ASUS Tinker Board",
    category: "asus",
  };

  async function renderCatalog(
    manifest: () => unknown = () => ({
      ...MOCK_MANIFEST,
      devices: [...MOCK_MANIFEST.devices, tinkerBoard],
    })
  ) {
    wizardState.startFlow("sbc");
    mockTauriIpc((cmd) => {
      expect(cmd).to.equal("get_manifest");
      return manifest();
    });
    const el = await fixture<DeviceSelectionView>(html`
      <device-selection-view></device-selection-view>
    `);
    await waitUntil(
      () => !el.shadowRoot!.querySelector(".loading"),
      "manifest load never settled"
    );
    return el;
  }

  function cards(el: DeviceSelectionView) {
    return [...el.shadowRoot!.querySelectorAll<DeviceCard>("device-card")];
  }

  it("offers only the single board computers in the catalog", async () => {
    const el = await renderCatalog();
    expect(cards(el).map((card) => card.value)).to.deep.equal([
      "rpi5",
      "rpi4",
      "rpi3",
      "odroid-n2",
      "odroid-c2",
      "odroid-c4",
      "odroid-m1",
      "odroid-m1s",
      "khadas-vim3",
      "tinker",
    ]);
    expect(cards(el)[0].name).to.equal("Raspberry Pi 5");
    expect(cards(el)[0].image).to.equal("/assets/devices/raspberry_pi_5.png");
  });

  it("exposes the boards as a named radio group", async () => {
    const el = await renderCatalog();
    await el.shadowRoot!.querySelector("wa-radio-group")!.updateComplete;

    const groups = findByRole(await fullA11ySnapshot(), "radiogroup");
    expect(groups).to.have.length(1);
    expect(groups[0]!.name).to.equal("Single board computer");
    expect(findByRole(groups[0]!, "radio")).to.have.length(10);
  });

  it("stores the chosen board for the following steps", async () => {
    const el = await renderCatalog();
    const odroid = cards(el).find((card) => card.value === "odroid-n2")!;

    odroid.click();
    await waitUntil(
      () => wizardState.getState().selections.device === "odroid-n2",
      "choice never stored"
    );

    const selections = wizardState.getState().selections;
    expect(selections.deviceName).to.equal("ODROID-N2/N2+");
    expect(selections.deviceImage).to.equal(
      "/assets/devices/hardkernel_odroid-n2.png"
    );
    expect(selections.deviceConfig!.board).to.equal("odroid-n2");
    expect(selections.deviceCatalogReady).to.equal(true);
  });

  it("shows a board chosen earlier as selected", async () => {
    wizardState.startFlow("sbc");
    wizardState.setSelection("device", "rpi4");
    mockTauriIpc(() => MOCK_MANIFEST);
    const el = await fixture<DeviceSelectionView>(html`
      <device-selection-view></device-selection-view>
    `);
    await waitUntil(() => cards(el).length > 0);
    const group = el.shadowRoot!.querySelector("wa-radio-group")!;
    await group.updateComplete;
    expect(group.value).to.equal("rpi4");
    expect(cards(el).filter((card) => card.checked)).to.have.length(1);
    expect(cards(el).find((card) => card.checked)!.value).to.equal("rpi4");
  });

  it("loads the catalog again on Try again", async () => {
    let attempts = 0;
    const reload = deferred<typeof MOCK_MANIFEST>();
    const el = await renderCatalog(() =>
      ++attempts === 1
        ? Promise.reject(ipcError("network", "offline", true))
        : reload.promise
    );
    const alert = el.shadowRoot!.querySelector('[role="alert"]')!;
    expect(alert.textContent).to.contain("Could not connect");
    expect(cards(el)).to.have.length(0);

    const retry = [...el.shadowRoot!.querySelectorAll("wa-button")].find(
      (button) => button.textContent!.includes("Try again")
    )!;
    retry.focus();
    retry.click();
    await el.updateComplete;
    // Try again stays, busy, with the focus, rather than giving way to a
    // spinner; the alert empties so the same failure would be read out again
    expect(el.shadowRoot!.querySelector(".error wa-button") === retry).to.be
      .true;
    expect(retry.hasAttribute("loading")).to.be.true;
    expect(alert.textContent!.trim()).to.equal("");
    expect(el.shadowRoot!.activeElement === retry).to.be.true;

    reload.resolve(MOCK_MANIFEST);
    await waitUntil(() => cards(el).length > 0, "catalog never reloaded");
    expect(attempts).to.equal(2);
    expect(el.shadowRoot!.querySelector('[role="alert"]')).to.not.exist;
    expect(wizardState.getState().selections.deviceCatalogReady).to.equal(true);
    // The list took its place, so the focus goes on from its heading
    await waitUntil(
      () => el.shadowRoot!.activeElement === el.shadowRoot!.querySelector("h2")
    );
  });
});
