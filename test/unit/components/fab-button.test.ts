import { expect, fixture, html } from "@open-wc/testing";
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

  it("sets aria-label from label", async () => {
    const el = await fixture<FabButton>(
      html`<fab-button .path=${TEST_PATH} label="Open Toolbox"></fab-button>`
    );

    const button = el.shadowRoot!.querySelector("wa-button")!;
    expect(button.getAttribute("aria-label")).to.equal("Open Toolbox");
  });

  it("omits aria-label when label is empty", async () => {
    const el = await fixture<FabButton>(
      html`<fab-button .path=${TEST_PATH}></fab-button>`
    );

    const button = el.shadowRoot!.querySelector("wa-button")!;
    expect(button.hasAttribute("aria-label")).to.be.false;
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
