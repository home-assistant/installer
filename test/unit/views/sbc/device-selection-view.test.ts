import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import "../../../../src/views/sbc/device-selection-view.js";
import type { DeviceSelectionView } from "../../../../src/views/sbc/device-selection-view.js";
import type { Device } from "../../../../src/api/index.js";
import { findByRole, fullA11ySnapshot } from "../../helpers/a11y.js";

describe("device-selection-view", () => {
  it("renders and shows loading or error state", async () => {
    const el = await fixture<DeviceSelectionView>(html`
      <device-selection-view></device-selection-view>
    `);

    // Component will either be in loading state, error state (no Tauri in test env),
    // or have loaded devices
    const loading = el.shadowRoot!.querySelector(".loading");
    const error = el.shadowRoot!.querySelector(".error");
    const grid = el.shadowRoot!.querySelector(".devices-grid");

    // One of these should exist
    expect(loading || error || grid).to.exist;
  });

  it("has the correct host styles", async () => {
    const el = await fixture<DeviceSelectionView>(html`
      <device-selection-view></device-selection-view>
    `);

    const styles = getComputedStyle(el);
    expect(styles.display).to.equal("flex");
  });

  it("exposes the devices as a named radiogroup", async () => {
    const el = await fixture<DeviceSelectionView>(html`
      <device-selection-view></device-selection-view>
    `);

    // No Tauri here, so let the manifest load fail, then inject devices.
    type Internals = {
      _loading: boolean;
      _error: string | null;
      _devices: Partial<Device>[];
    };
    const view = el as unknown as Internals;
    await waitUntil(() => !view._loading, "manifest load never settled");
    view._error = null;
    view._devices = [
      { id: "rpi5", name: "Raspberry Pi 5" },
      { id: "rpi4", name: "Raspberry Pi 4" },
    ];
    await el.updateComplete;
    const group = el.shadowRoot!.querySelector("wa-radio-group") as
      | (HTMLElement & { updateComplete: Promise<unknown> })
      | null;
    expect(group).to.exist;
    await group!.updateComplete;

    const groups = findByRole(await fullA11ySnapshot(), "radiogroup");
    expect(groups).to.have.length(1);
    expect(groups[0]!.name).to.equal("Single board computer");
    expect(findByRole(groups[0]!, "radio")).to.have.length(2);
  });
});
