import { expect } from "@open-wc/testing";
import { html, render, type LitElement } from "lit";
import "../../../src/components/step-indicator.js";
import "../../../src/components/install-progress.js";
import type { StepIndicator } from "../../../src/components/step-indicator.js";
import type { InstallProgress } from "../../../src/components/install-progress.js";
import { statusDotStyles } from "../../../src/utils/status-dot-styles.js";

// The step indicator and the install's stage list draw the same dots, each in
// its own size, so the two can't drift apart.
// How they look in forced colors is in test/e2e/accessibility.spec.ts.

const LOOK: (keyof CSSStyleDeclaration)[] = [
  "boxSizing",
  "borderTopWidth",
  "borderTopStyle",
  "borderTopColor",
  "borderTopLeftRadius",
  "backgroundColor",
  "outlineStyle",
  "outlineWidth",
  "outlineOffset",
];

function pick(element: Element, properties: (keyof CSSStyleDeclaration)[]) {
  const style = getComputedStyle(element);
  return Object.fromEntries(properties.map((name) => [name, style[name]]));
}

describe("status dot styles", () => {
  let container: HTMLElement;
  let indicator: StepIndicator;
  let progress: InstallProgress;

  const dots = (el: LitElement) => [
    ...el.shadowRoot!.querySelectorAll<HTMLElement>(".status-dot"),
  ];

  beforeEach(async () => {
    // A plain container: fixture() would wait for a frame, which a background
    // test page never paints
    container = document.body.appendChild(document.createElement("div"));
    render(
      html`<step-indicator
          .steps=${["Drive", "Confirm", "Install"].map((title) => ({
            id: title,
            title,
          }))}
          .currentIndex=${1}
        ></step-indicator>
        <install-progress
          .stages=${["downloading", "writing", "verifying"].map((id) => ({
            id,
            label: id,
          }))}
          stage="writing"
        ></install-progress>`,
      container
    );
    [indicator, progress] = [...container.children] as [
      StepIndicator,
      InstallProgress,
    ];
    await Promise.all([indicator.updateComplete, progress.updateComplete]);
    // The current stage's pulse would change its fill while it is read
    for (const dot of dots(progress)) {
      for (const animation of dot.getAnimations()) animation.cancel();
    }
  });

  afterEach(() => {
    container.remove();
  });

  it("draws completed, current and upcoming alike in both lists", () => {
    const look = (el: LitElement) => dots(el).map((dot) => pick(dot, LOOK));
    expect(look(progress)).to.deep.equal(look(indicator));
    const [completed, current, upcoming] = look(indicator);
    expect(completed).to.not.deep.equal(current);
    expect(current).to.not.deep.equal(upcoming);
    expect(
      pick(dots(progress)[1]!, ["outlineColor"]),
      "the current ring"
    ).to.deep.equal(pick(dots(indicator)[1]!, ["outlineColor"]));
  });

  it("keeps the stage list's dots smaller than the step indicator's", () => {
    const size = (el: LitElement) =>
      dots(el).map((dot) => pick(dot, ["width", "height"]));
    expect(size(indicator)).to.deep.equal(
      Array(3).fill({ width: "10px", height: "10px" })
    );
    expect(size(progress)).to.deep.equal(
      Array(3).fill({ width: "8px", height: "8px" })
    );
  });

  // Copies of these rules could drift apart
  it("is styled by the shared rules in both lists", () => {
    for (const tag of ["step-indicator", "install-progress"]) {
      const styles = (customElements.get(tag) as typeof LitElement)
        .elementStyles;
      expect(styles, tag).to.include(statusDotStyles);
    }
  });
});
