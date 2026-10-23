import { expect, fixture, html } from "@open-wc/testing";
import type { TemplateResult } from "lit";
import { wizardState } from "../../../src/state/wizard-state.js";
import "../../../src/components/wizard-shell.js";
import "../../../src/views/welcome-view.js";
import "../../../src/views/path-selection-view.js";
import "../../../src/views/other-options-view.js";
import "../../../src/views/connection-check-view.js";

// The gutter is set on the host, as styles.css sets it on the page
const SCREENS: [string, TemplateResult, string[]][] = [
  [
    "welcome-view",
    html`<welcome-view style="--ha-page-gutter: 5px"></welcome-view>`,
    [],
  ],
  [
    "path-selection-view",
    html`<path-selection-view
      style="--ha-page-gutter: 5px"
    ></path-selection-view>`,
    [".header", ".content"],
  ],
  [
    "other-options-view",
    html`<other-options-view
      style="--ha-page-gutter: 5px"
    ></other-options-view>`,
    [".header", ".content"],
  ],
  [
    "connection-check-view",
    html`<connection-check-view
      style="--ha-page-gutter: 5px"
    ></connection-check-view>`,
    [".header", ".content"],
  ],
  [
    "wizard-shell",
    html`<wizard-shell style="--ha-page-gutter: 5px"></wizard-shell>`,
    [".header", ".content", ".footer"],
  ],
];

describe("page gutter", () => {
  // The wizard shell shows the steps of a flow
  beforeEach(() => wizardState.startFlow("sbc"));
  afterEach(() => wizardState.reset());

  for (const [name, template, parts] of SCREENS) {
    it(`keeps the sides of ${name} at the page gutter`, async () => {
      const el = await fixture<HTMLElement>(template);
      // A screen without a header or footer pads itself
      const elements = parts.length
        ? parts.map((part) => el.shadowRoot!.querySelector(part)!)
        : [el];
      for (const element of elements) {
        const style = getComputedStyle(element);
        expect([style.paddingLeft, style.paddingRight]).to.deep.equal([
          "5px",
          "5px",
        ]);
      }
    });
  }

  it("puts Back in the same header on the screens before the flow", async () => {
    for (const [name, template] of SCREENS.slice(1, 4)) {
      const el = await fixture<HTMLElement>(template);
      const back = el.shadowRoot!.querySelector(".header wa-button");
      expect(back?.textContent?.replace(/\s+/g, " ").trim(), name).to.equal(
        "← Back"
      );
      expect(back!.getAttribute("appearance"), name).to.equal("plain");
    }
  });
});
