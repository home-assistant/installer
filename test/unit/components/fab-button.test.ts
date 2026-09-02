import { elementUpdated, expect, fixture, html } from "@open-wc/testing";
import "../../../src/components/fab-button.js";
import type { FabButton } from "../../../src/components/fab-button.js";
import type { HaSvgIcon } from "../../../src/components/ha-svg-icon.js";

const TEST_PATH = "M0 0h24v24H0z";

describe("fab-button", () => {
  it("renders a wa-button", async () => {
    const el = await fixture<FabButton>(
      html`<fab-button .path=${TEST_PATH} label="Open"></fab-button>`
    );

    expect(el.shadowRoot!.querySelector("wa-button")).to.exist;
  });

  it("renders the icon with the given path", async () => {
    const el = await fixture<FabButton>(
      html`<fab-button .path=${TEST_PATH} label="Open"></fab-button>`
    );

    const icon = el.shadowRoot!.querySelector<HaSvgIcon>("ha-svg-icon");
    expect(icon).to.exist;
    expect(icon!.path).to.equal(TEST_PATH);
  });

  it("gives the button an accessible name from label", async () => {
    const el = await fixture<FabButton>(
      html`<fab-button .path=${TEST_PATH} label="Open Toolbox"></fab-button>`
    );

    // The icon is aria-hidden, so the label has to come from aria-label. Assert
    // on the <button> inside wa-button too: that's the control assistive tech
    // sees, and it only gets a name because wa-button mirrors its own
    // aria-label onto it.
    const waButton = el.shadowRoot!.querySelector("wa-button")!;
    await elementUpdated(waButton);
    expect(waButton.getAttribute("aria-label")).to.equal("Open Toolbox");
    expect(
      waButton.shadowRoot!.querySelector("button")!.getAttribute("aria-label")
    ).to.equal("Open Toolbox");
  });

  it("sets no accessible name when label is empty", async () => {
    const el = await fixture<FabButton>(
      html`<fab-button .path=${TEST_PATH}></fab-button>`
    );

    const waButton = el.shadowRoot!.querySelector("wa-button")!;
    await elementUpdated(waButton);
    expect(waButton.hasAttribute("aria-label")).to.be.false;
    expect(
      waButton.shadowRoot!.querySelector("button")!.hasAttribute("aria-label")
    ).to.be.false;
  });

  it("renders a tooltip with the label", async () => {
    const el = await fixture<FabButton>(
      html`<fab-button .path=${TEST_PATH} label="Open Toolbox"></fab-button>`
    );

    const tooltip = el.shadowRoot!.querySelector("wa-tooltip");
    expect(tooltip).to.exist;
    expect(tooltip!.textContent!.trim()).to.equal("Open Toolbox");
  });

  it("renders no tooltip when label is empty", async () => {
    const el = await fixture<FabButton>(
      html`<fab-button .path=${TEST_PATH}></fab-button>`
    );

    expect(el.shadowRoot!.querySelector("wa-tooltip")).to.not.exist;
  });
});
