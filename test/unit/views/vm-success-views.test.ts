import { expect, fixtureSync, html } from "@open-wc/testing";
import { wizardState } from "../../../src/state/wizard-state.js";
import "../../../src/views/utm/utm-success-view.js";
import "../../../src/views/proxmox/proxmox-success-view.js";
import { settle } from "../tauri-ipc.js";

describe("VM success views", () => {
  afterEach(() => {
    wizardState.reset();
  });

  for (const [flow, tip] of [
    ["utm", "by opening UTM"],
    ["proxmox", "from the Proxmox web interface"],
  ] as const) {
    it(`points ${flow} at homeassistant.local when the install found no address`, async () => {
      wizardState.startFlow(flow === "utm" ? "vm" : flow);
      const view = fixtureSync(
        flow === "utm"
          ? html`<utm-success-view></utm-success-view>`
          : html`<proxmox-success-view></proxmox-success-view>`
      );
      await settle();
      const content =
        view.shadowRoot!.querySelector("install-success")!.shadowRoot!;

      const link = content.querySelector<HTMLAnchorElement>(".step-text a")!;
      expect(link.getAttribute("href")).to.equal("http://homeassistant.local");
      expect(link.textContent).to.equal("homeassistant.local");

      const tipSection = content.querySelector(".tip-section")!;
      expect(tipSection.querySelector("strong")!.textContent).to.equal("Tip:");
      expect(tipSection.textContent).to.contain(tip);
    });
  }
});
