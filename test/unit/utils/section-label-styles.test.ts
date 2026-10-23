import { expect } from "@open-wc/testing";
import { html, render, type CSSResult, type LitElement } from "lit";
import "../../../src/components/install-success.js";
import type { InstallSuccess } from "../../../src/components/install-success.js";
import "../../../src/views/sbc/confirmation-view.js";
import "../../../src/views/sbc/drive-selection-view.js";
import "../../../src/views/proxmox/proxmox-confirm-view.js";
import "../../../src/views/utm/utm-confirm-view.js";
import { sectionLabelStyles } from "../../../src/utils/section-label-styles.js";
import {
  renderSummaryRow,
  summaryStyles,
} from "../../../src/utils/summary-styles.js";

// The labels became h3 headings, so they must not take on a heading's own
// size, weight or margins: they look as they did as paragraphs.

const USERS = [
  "install-success",
  "drive-selection-view",
  "confirmation-view",
  "utm-confirm-view",
  "proxmox-confirm-view",
];

function pick(element: Element, properties: (keyof CSSStyleDeclaration)[]) {
  const style = getComputedStyle(element);
  return Object.fromEntries(properties.map((name) => [name, style[name]]));
}

const LOOK: (keyof CSSStyleDeclaration)[] = [
  "fontSize",
  "fontWeight",
  "textTransform",
  "letterSpacing",
  "marginTop",
  "marginBottom",
];

describe("section label styles", () => {
  let host: HTMLElement;

  // A plain container: fixture() would wait for a frame, which a background
  // test page never paints
  function shadowed(styles: CSSResult, template: unknown) {
    host = document.body.appendChild(document.createElement("div"));
    const root = host.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = [styles.styleSheet!];
    render(template, root);
    return root;
  }

  afterEach(() => {
    host.remove();
  });

  it("reads as a small uppercase label, not a heading", () => {
    const root = shadowed(
      sectionLabelStyles,
      html`<h3 class="section-label">Available drives</h3>`
    );
    expect(pick(root.querySelector("h3")!, LOOK)).to.deep.equal({
      fontSize: "14px",
      fontWeight: "500",
      textTransform: "uppercase",
      letterSpacing: "0.7px",
      marginTop: "0px",
      marginBottom: "0px",
    });
  });

  it("is smaller in a summary row, with a little room under it", () => {
    const root = shadowed(
      summaryStyles,
      renderSummaryRow("", "Target drive", "SanDisk Ultra")
    );
    expect(pick(root.querySelector("h3")!, LOOK)).to.deep.equal({
      fontSize: "12px",
      fontWeight: "500",
      textTransform: "uppercase",
      letterSpacing: "0.6px",
      marginTop: "0px",
      marginBottom: "4px",
    });
  });

  it("keeps the success step's headings as they looked", async () => {
    host = document.body.appendChild(document.createElement("div"));
    render(html`<install-success></install-success>`, host);
    const el = host.querySelector<InstallSuccess>("install-success")!;
    await el.updateComplete;
    const root = el.shadowRoot!;

    expect(
      pick(root.querySelector("h3.next-steps-title")!, LOOK)
    ).to.deep.equal({
      fontSize: "14px",
      fontWeight: "500",
      textTransform: "uppercase",
      letterSpacing: "0.7px",
      marginTop: "0px",
      marginBottom: "16px",
    });
    expect(pick(root.querySelector("h3.companion-title")!, LOOK)).to.deep.equal(
      {
        fontSize: "16px",
        fontWeight: "500",
        textTransform: "none",
        letterSpacing: "normal",
        marginTop: "0px",
        marginBottom: "16px",
      }
    );
  });

  // Copies of these rules could drift apart
  it("is styled by the shared rules wherever it is used", () => {
    for (const tag of USERS) {
      const css = (customElements.get(tag) as typeof LitElement).elementStyles
        .map((style) => ("cssText" in style ? style.cssText : ""))
        .join("\n");
      expect(css, tag).to.contain(sectionLabelStyles.cssText);
      expect(css.match(/text-transform:\s*uppercase/g), tag).to.have.length(1);
    }
  });
});
