import { expect } from "@open-wc/testing";
import { render } from "lit";
import { mdiAlert, mdiMemory } from "../../../src/utils/icons.js";
import { renderIcon } from "../../../src/utils/render-icon.js";

function rendered(template: unknown): HTMLDivElement {
  const container = document.createElement("div");
  render(template, container);
  return container;
}

describe("renderIcon", () => {
  it("draws the path on a 24 by 24 viewBox", () => {
    const svg = rendered(renderIcon(mdiMemory)).querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).to.equal("0 0 24 24");
    expect(svg.querySelector("path")!.getAttribute("d")).to.equal(mdiMemory);
  });

  it("hides the icon from assistive technology", () => {
    const svg = rendered(renderIcon(mdiMemory)).querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).to.equal("true");
  });

  it("is an SVG element, so a stylesheet's svg selectors reach it", () => {
    const svg = rendered(renderIcon(mdiMemory)).querySelector("svg")!;
    expect(svg.namespaceURI).to.equal("http://www.w3.org/2000/svg");
    expect(svg.querySelector("path")!.namespaceURI).to.equal(
      "http://www.w3.org/2000/svg"
    );
  });

  it("carries the class it is given, and none otherwise", () => {
    const styled = rendered(renderIcon(mdiAlert, "error-icon")).querySelector(
      "svg"
    )!;
    expect(styled.getAttribute("class")).to.equal("error-icon");
    const plain = rendered(renderIcon(mdiAlert)).querySelector("svg")!;
    expect(plain.hasAttribute("class")).to.be.false;
  });
});
