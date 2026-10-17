import { expect, fixtureSync, html } from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/live-usb/live-usb-success-view.js";

describe("live-usb-success-view", () => {
  afterEach(() => {
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

    const notice = layout.shadowRoot!.querySelector<HTMLElement>(".notice")!;
    expect(notice.scrollWidth).to.be.at.most(notice.clientWidth);
    const row = notice.querySelector<HTMLElement>(".saved-row")!;
    expect(getComputedStyle(row).display).to.equal("flex");
  });
});
