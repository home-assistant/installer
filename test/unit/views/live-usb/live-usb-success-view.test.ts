import { expect, fixtureSync, html } from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/live-usb/live-usb-success-view.js";
import type { LiveUsbSuccessView } from "../../../../src/views/live-usb/live-usb-success-view.js";
import { mockTauriIpc, restoreTauriIpc, settle } from "../../tauri-ipc.js";

describe("live-usb-success-view", () => {
  afterEach(() => {
    restoreTauriIpc();
    wizardState.reset();
  });

  it("wraps a long ISO path and keeps the show-in-folder row", async () => {
    wizardState.startFlow("minipc");
    wizardState.setSelection("liveMedia", "iso");
    wizardState.setSelection(
      "liveIsoPath",
      `/home/me/${"a-very-long-folder-name".repeat(12)}/stick.iso`
    );
    const wrapper = fixtureSync<HTMLDivElement>(
      html`<div style="width: 320px">
        <live-usb-success-view></live-usb-success-view>
      </div>`
    );
    const view = wrapper.querySelector("live-usb-success-view")!;
    await view.updateComplete;
    const layout = view.shadowRoot!.querySelector("install-success")!;
    await layout.updateComplete;

    // Where it was saved goes under the steps, in the success layout's slot
    const row = view.shadowRoot!.querySelector<HTMLElement>(
      "install-success > .saved-row"
    )!;
    expect(row.assignedSlot).to.exist;
    expect(row.scrollWidth).to.be.at.most(row.clientWidth);
    expect(getComputedStyle(row).display).to.equal("flex");
  });

  it("warns not to format a written stick, not a saved ISO", async () => {
    for (const [media, warns] of [
      ["usb", true],
      ["iso", false],
    ] as const) {
      wizardState.startFlow("minipc");
      wizardState.setSelection("liveMedia", media);
      wizardState.setSelection("liveIsoPath", "/home/me/haos.iso");
      const view = fixtureSync<LiveUsbSuccessView>(
        html`<live-usb-success-view></live-usb-success-view>`
      );
      await view.updateComplete;

      expect(
        view.shadowRoot!.querySelector("install-success")!.formatWarning
      ).to.equal(warns);
      wizardState.reset();
    }
  });

  it("says so when the folder can't be shown", async () => {
    wizardState.startFlow("minipc");
    wizardState.setSelection("liveMedia", "iso");
    wizardState.setSelection("liveIsoPath", "/home/me/haos.iso");
    const shown: unknown[] = [];
    mockTauriIpc((command, args) => {
      expect(command).to.equal("reveal_in_folder");
      shown.push(args);
      return Promise.reject("No file manager");
    });
    const view = fixtureSync<LiveUsbSuccessView>(
      html`<live-usb-success-view></live-usb-success-view>`
    );
    await view.updateComplete;
    const layout = view.shadowRoot!.querySelector("install-success")!;
    await layout.updateComplete;

    view
      .shadowRoot!.querySelector<HTMLElement>(".saved-row wa-button")!
      .click();
    await settle();
    await layout.updateComplete;

    expect(shown).to.deep.equal([{ path: "/home/me/haos.iso" }]);
    expect(
      view.shadowRoot!.querySelector('.saved-row [role="alert"]')?.textContent
    ).to.contain("The folder couldn't be opened.");
  });
});
