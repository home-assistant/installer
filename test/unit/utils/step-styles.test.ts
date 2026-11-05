import { expect, fixture, html } from "@open-wc/testing";
import { LitElement } from "lit";
import {
  renderStepHeading,
  stepStyles,
} from "../../../src/utils/step-styles.js";
import "../../../src/views/ha-hardware/device-selection-view.js";
import "../../../src/views/ha-hardware/module-selection-view.js";
import "../../../src/views/live-usb/live-iso-location-view.js";
import "../../../src/views/live-usb/live-usb-summary-view.js";
import "../../../src/views/minipc/architecture-selection-view.js";
import "../../../src/views/minipc/media-view.js";
import "../../../src/views/minipc/setup-method-view.js";
import "../../../src/views/proxmox/proxmox-configure-view.js";
import "../../../src/views/proxmox/proxmox-confirm-view.js";
import "../../../src/views/proxmox/proxmox-connect-view.js";
import "../../../src/views/sbc/confirmation-view.js";
import "../../../src/views/sbc/device-selection-view.js";
import "../../../src/views/sbc/drive-selection-view.js";
import "../../../src/views/sbc/wifi-view.js";
import "../../../src/views/utm/utm-check-view.js";
import "../../../src/views/utm/utm-configure-view.js";
import "../../../src/views/utm/utm-confirm-view.js";

const STEPS = [
  "ha-hardware-device-selection-view",
  "ha-hardware-module-selection-view",
  "live-iso-location-view",
  "live-usb-summary-view",
  "minipc-architecture-selection-view",
  "minipc-media-view",
  "minipc-setup-method-view",
  "proxmox-configure-view",
  "proxmox-confirm-view",
  "proxmox-connect-view",
  "confirmation-view",
  "device-selection-view",
  "drive-selection-view",
  "wifi-view",
  "utm-check-view",
  "utm-configure-view",
  "utm-confirm-view",
];

class TestStep extends LitElement {
  static styles = stepStyles;

  render() {
    return renderStepHeading("Pick a drive", "It will be erased.");
  }
}
customElements.define("test-step", TestStep);

describe("step heading", () => {
  it("renders the title as the heading and the subtitle below it", async () => {
    const el = await fixture<TestStep>(html`<test-step></test-step>`);
    const [heading, subtitle] = el.shadowRoot!.children;
    expect(heading.tagName).to.equal("H2");
    expect(heading.textContent).to.equal("Pick a drive");
    expect(subtitle.tagName).to.equal("P");
    expect(subtitle.className).to.equal("subtitle");
    expect(subtitle.textContent).to.equal("It will be erased.");
  });

  // Copies of these rules had drifted apart: some steps left a wider gap
  // under the subtitle, most let it run wider than the column below
  it("is styled by the shared rules on every step", () => {
    for (const tag of STEPS) {
      const styles = (customElements.get(tag) as typeof LitElement)
        .elementStyles;
      expect(styles.includes(stepStyles), tag).to.be.true;
      const own = styles
        .filter((style) => style !== stepStyles)
        .map((style) => ("cssText" in style ? style.cssText : ""))
        .join("\n");
      expect(own, tag).not.to.match(/(^|[\s}])(:host|h2|\.subtitle)\s*\{/);
    }
  });
});
