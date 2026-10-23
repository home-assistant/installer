import { expect } from "@open-wc/testing";
import { html, render, type LitElement } from "lit";
import "../../../src/components/install-success.js";
import "../../../src/views/proxmox/proxmox-configure-view.js";
import "../../../src/views/proxmox/proxmox-confirm-view.js";
import "../../../src/views/proxmox/proxmox-connect-view.js";
import "../../../src/views/sbc/confirmation-view.js";
import "../../../src/views/sbc/wifi-view.js";
import "../../../src/views/utm/utm-check-view.js";
import "../../../src/views/utm/utm-configure-view.js";
import "../../../src/views/utm/utm-confirm-view.js";
import { panelStyles } from "../../../src/utils/panel-styles.js";

// Copies of the panel had drifted apart in their padding and gaps. Each one
// takes its box from panelStyles now; only the spacing its content needs may
// differ.

const PANELS: {
  tag: string;
  selector: string;
  own?: Partial<Record<keyof CSSStyleDeclaration, string>>;
}[] = [
  { tag: "confirmation-view", selector: ".summary-card" },
  { tag: "utm-confirm-view", selector: ".summary-card" },
  { tag: "proxmox-confirm-view", selector: ".summary-card" },
  { tag: "utm-configure-view", selector: ".config-card" },
  { tag: "proxmox-configure-view", selector: ".config-card" },
  { tag: "proxmox-connect-view", selector: ".connect-card" },
  { tag: "wifi-view", selector: ".wifi-card" },
  {
    tag: "utm-check-view",
    selector: ".status-card",
    own: { alignItems: "center", rowGap: "16px" },
  },
  {
    tag: "install-success",
    selector: ".companion-section",
    own: { rowGap: "16px" },
  },
];

/** The box, in a column wider than it, in the light theme */
const PANEL = {
  display: "flex",
  flexDirection: "column",
  alignItems: "normal",
  rowGap: "24px",
  paddingTop: "24px",
  paddingRight: "24px",
  paddingBottom: "24px",
  paddingLeft: "24px",
  backgroundColor: "rgb(255, 255, 255)",
  borderTopWidth: "1px",
  borderTopStyle: "solid",
  borderTopColor: "rgb(224, 224, 224)",
  borderTopLeftRadius: "12px",
  boxSizing: "border-box",
  width: "500px",
};

function pick(element: Element, properties: (keyof CSSStyleDeclaration)[]) {
  const style = getComputedStyle(element);
  return Object.fromEntries(properties.map((name) => [name, style[name]]));
}

const stylesOf = (tag: string) =>
  (customElements.get(tag) as typeof LitElement).elementStyles;

describe("panel styles", () => {
  let host: HTMLElement;

  afterEach(() => {
    host.remove();
  });

  for (const { tag, selector, own } of PANELS) {
    it(`gives ${tag}'s ${selector} the panel's box`, () => {
      // The step's own sheets on a plain container: fixture() would wait for
      // a frame, which a background test page never paints, and the views
      // start loading as soon as they connect
      host = document.body.appendChild(document.createElement("div"));
      host.style.width = "600px";
      const root = host.attachShadow({ mode: "open" });
      root.adoptedStyleSheets = stylesOf(tag).map((style) =>
        style instanceof CSSStyleSheet ? style : style.styleSheet!
      );
      render(html`<div class=${selector.slice(1)}></div>`, root);

      const box = pick(
        root.querySelector(selector)!,
        Object.keys(PANEL) as (keyof CSSStyleDeclaration)[]
      );
      expect(box).to.deep.equal({ ...PANEL, ...own });
    });
  }

  it("is the only box of its kind on those steps", () => {
    for (const tag of new Set(PANELS.map(({ tag }) => tag))) {
      const css = stylesOf(tag)
        .map((style) => ("cssText" in style ? style.cssText : ""))
        .join("\n");
      expect(css, tag).to.contain(panelStyles.cssText);
      expect(css.match(/--ha-card-border-radius/g), tag).to.have.length(1);
    }
  });
});
