import { expect, fixture, html } from "@open-wc/testing";
import "../../../src/components/ha-svg-icon.js";
import type { HaSvgIcon } from "../../../src/components/ha-svg-icon.js";

const TEST_PATH = "M0 0h24v24H0z";
const SECONDARY_PATH = "M12 2v20";

describe("ha-svg-icon", () => {
  it("renders an svg", async () => {
    const el = await fixture<HaSvgIcon>(
      html`<ha-svg-icon .path=${TEST_PATH}></ha-svg-icon>`
    );

    expect(el.shadowRoot!.querySelector("svg")).to.exist;
  });

  it("renders the primary path", async () => {
    const el = await fixture<HaSvgIcon>(
      html`<ha-svg-icon .path=${TEST_PATH}></ha-svg-icon>`
    );

    const path = el.shadowRoot!.querySelector("path.primary-path");
    expect(path).to.exist;
    expect(path!.getAttribute("d")).to.equal(TEST_PATH);
  });

  it("uses the default viewBox", async () => {
    const el = await fixture<HaSvgIcon>(
      html`<ha-svg-icon .path=${TEST_PATH}></ha-svg-icon>`
    );

    expect(
      el.shadowRoot!.querySelector("svg")!.getAttribute("viewBox")
    ).to.equal("0 0 24 24");
  });

  it("uses a custom viewBox when provided", async () => {
    const el = await fixture<HaSvgIcon>(
      html`<ha-svg-icon
        .path=${TEST_PATH}
        .viewBox=${"0 0 48 48"}
      ></ha-svg-icon>`
    );

    expect(
      el.shadowRoot!.querySelector("svg")!.getAttribute("viewBox")
    ).to.equal("0 0 48 48");
  });

  it("renders a secondary path when provided", async () => {
    const el = await fixture<HaSvgIcon>(
      html`<ha-svg-icon
        .path=${TEST_PATH}
        .secondaryPath=${SECONDARY_PATH}
      ></ha-svg-icon>`
    );

    const secondary = el.shadowRoot!.querySelector("path.secondary-path");
    expect(secondary).to.exist;
    expect(secondary!.getAttribute("d")).to.equal(SECONDARY_PATH);
  });

  it("renders no primary path when path is unset", async () => {
    const el = await fixture<HaSvgIcon>(html`<ha-svg-icon></ha-svg-icon>`);

    expect(el.shadowRoot!.querySelector("path.primary-path")).to.not.exist;
  });

  it("marks the icon as decorative (aria-hidden)", async () => {
    const el = await fixture<HaSvgIcon>(
      html`<ha-svg-icon .path=${TEST_PATH}></ha-svg-icon>`
    );

    expect(
      el.shadowRoot!.querySelector("svg")!.getAttribute("aria-hidden")
    ).to.equal("true");
  });
});
