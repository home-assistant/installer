import { expect, fixture, html } from "@open-wc/testing";
import { setViewport } from "@web/test-runner-commands";
import "../../../src/components/step-indicator.js";
import type { StepIndicator } from "../../../src/components/step-indicator.js";
import type { WizardStep } from "../../../src/state/wizard-state.js";
import { findByRole, fullA11ySnapshot } from "../helpers/a11y.js";

describe("step-indicator", () => {
  const mockSteps: WizardStep[] = [
    { id: "step1", title: "First Step" },
    { id: "step2", title: "Second Step" },
    { id: "step3", title: "Third Step" },
  ];
  // The Mini PC steps for a board with Wi-Fi, the most there are
  const longSteps: WizardStep[] = [
    "Installation method",
    "Select processor",
    "Select drive",
    "Wi-Fi",
    "Confirm",
    "Install",
    "Done",
  ].map((title, index) => ({ id: `step${index}`, title }));

  const shown = (el: StepIndicator) =>
    [...el.shadowRoot!.querySelectorAll<HTMLElement>(".step-label")].map(
      (label) => label.offsetWidth > 1
    );
  // Steps on one line share a vertical center, whatever their height
  const rows = (el: StepIndicator) =>
    new Set(
      [...el.shadowRoot!.querySelectorAll<HTMLElement>(".step")].map((step) =>
        Math.round(step.offsetTop + step.offsetHeight / 2)
      )
    ).size;
  // List items have no accessible name, so read their text in order.
  const announced = async () =>
    findByRole(await fullA11ySnapshot(), "listitem").map((item) =>
      findByRole(item, "StaticText")
        .map((text) => text.name)
        .join(" ")
    );

  it("renders all steps", async () => {
    const el = await fixture<StepIndicator>(html`
      <step-indicator .steps=${mockSteps} .currentIndex=${0}></step-indicator>
    `);

    const steps = el.shadowRoot!.querySelectorAll(".step");
    expect(steps.length).to.equal(3);
  });

  it("shows step titles", async () => {
    const el = await fixture<StepIndicator>(html`
      <step-indicator .steps=${mockSteps} .currentIndex=${0}></step-indicator>
    `);

    const labels = el.shadowRoot!.querySelectorAll(".step-label");
    expect(labels[0].textContent?.trim()).to.equal("First Step");
    expect(labels[1].textContent?.trim()).to.equal("Second Step (upcoming)");
    expect(labels[2].textContent?.trim()).to.equal("Third Step (upcoming)");
  });

  it("tells screen readers which steps are done and which are upcoming", async () => {
    const el = await fixture<StepIndicator>(html`
      <step-indicator .steps=${mockSteps} .currentIndex=${1}></step-indicator>
    `);

    expect(await announced()).to.deep.equal([
      "First Step (completed)",
      "Second Step",
      "Third Step (upcoming)",
    ]);
    el.currentIndex = 2;
    await el.updateComplete;
    expect(await announced()).to.deep.equal([
      "First Step (completed)",
      "Second Step (completed)",
      "Third Step",
    ]);
  });

  it("names only the current step when the names don't fit on one line", async () => {
    const el = await fixture<StepIndicator>(html`
      <step-indicator
        style="width: 240px"
        .steps=${mockSteps}
        .currentIndex=${1}
      ></step-indicator>
    `);

    expect(el.hasAttribute("compact")).to.be.true;
    expect(shown(el)).to.deep.equal([false, true, false]);
    expect(rows(el)).to.equal(1);
    // The others are hidden only from sight
    expect(await announced()).to.deep.equal([
      "First Step (completed)",
      "Second Step",
      "Third Step (upcoming)",
    ]);

    el.style.width = "800px";
    el.currentIndex = 2;
    await el.updateComplete;
    expect(el.hasAttribute("compact")).to.be.false;
    expect(shown(el)).to.deep.equal([true, true, true]);
  });

  it("wraps the current name beside its dot when it doesn't fit there either", async () => {
    const el = await fixture<StepIndicator>(html`
      <step-indicator
        style="width: 360px"
        .steps=${longSteps}
        .currentIndex=${0}
      ></step-indicator>
    `);
    const label = el.shadowRoot!.querySelector<HTMLElement>(".step-label")!;
    const lines = () => {
      const range = document.createRange();
      range.selectNodeContents(label);
      return [...range.getClientRects()];
    };

    expect(shown(el)).to.deep.equal([true, ...Array(6).fill(false)]);
    expect(rows(el)).to.equal(1);
    expect(lines().length).to.equal(2);
    // The next line follows the longest line of the name, as it follows a dot
    const end = Math.max(...lines().map((line) => line.right));
    const connector = el.shadowRoot!.querySelector(".step-connector")!;
    const dot = el.shadowRoot!.querySelectorAll(".step-dot")[1];
    expect(connector.getBoundingClientRect().left - end).to.be.closeTo(
      dot.getBoundingClientRect().left -
        connector.getBoundingClientRect().right,
      1
    );

    // Completed in a wider window, it is one line again, like the others
    el.style.width = "1200px";
    el.currentIndex = 1;
    await el.updateComplete;
    expect(shown(el)).to.deep.equal(Array(7).fill(true));
    const next = el.shadowRoot!.querySelectorAll<HTMLElement>(".step-label")[1];
    expect(label.offsetHeight).to.equal(next.offsetHeight);
  });

  it("marks current step as active", async () => {
    const el = await fixture<StepIndicator>(html`
      <step-indicator .steps=${mockSteps} .currentIndex=${1}></step-indicator>
    `);

    const dots = el.shadowRoot!.querySelectorAll(".step-dot");
    expect(dots[0].classList.contains("completed")).to.be.true;
    expect(dots[1].classList.contains("active")).to.be.true;
    expect(dots[2].classList.contains("active")).to.be.false;
    const current = el.shadowRoot!.querySelectorAll('[aria-current="step"]');
    expect(current.length).to.equal(1);
    expect(current[0].textContent?.trim()).to.equal("Second Step");
    el.currentIndex = 2;
    await el.updateComplete;
    expect(
      el.shadowRoot!.querySelector('[aria-current="step"]')!.textContent?.trim()
    ).to.equal("Third Step");
  });

  it("marks previous steps as completed", async () => {
    const el = await fixture<StepIndicator>(html`
      <step-indicator .steps=${mockSteps} .currentIndex=${2}></step-indicator>
    `);

    const dots = el.shadowRoot!.querySelectorAll(".step-dot");
    expect(dots[0].classList.contains("completed")).to.be.true;
    expect(dots[1].classList.contains("completed")).to.be.true;
    expect(dots[2].classList.contains("active")).to.be.true;
  });

  it("draws each state as its own shape, not only its own color", async () => {
    const el = await fixture<StepIndicator>(html`
      <step-indicator .steps=${mockSteps} .currentIndex=${1}></step-indicator>
    `);
    const [completed, current, upcoming] = [
      ...el.shadowRoot!.querySelectorAll(".step-dot"),
    ].map((dot) => getComputedStyle(dot));
    const empty = "rgba(0, 0, 0, 0)";

    // Upcoming: an empty ring
    expect(upcoming.backgroundColor).to.equal(empty);
    expect(upcoming.borderTopStyle).to.equal("solid");
    expect(upcoming.borderTopWidth).to.equal("2px");
    expect(upcoming.outlineStyle).to.equal("none");
    // Completed: a filled dot
    expect(completed.backgroundColor).to.not.equal(empty);
    expect(completed.outlineStyle).to.equal("none");
    // Current: a filled dot in a ring
    expect(current.backgroundColor).to.not.equal(empty);
    expect(current.outlineStyle).to.equal("solid");
    expect(current.outlineWidth).to.equal("2px");
  });

  it("renders connectors between steps", async () => {
    const el = await fixture<StepIndicator>(html`
      <step-indicator .steps=${mockSteps} .currentIndex=${0}></step-indicator>
    `);

    const connectors = el.shadowRoot!.querySelectorAll(".step-connector");
    expect(connectors.length).to.equal(2); // 3 steps = 2 connectors
  });

  it("marks connectors as completed for passed steps", async () => {
    const el = await fixture<StepIndicator>(html`
      <step-indicator .steps=${mockSteps} .currentIndex=${2}></step-indicator>
    `);

    const connectors = el.shadowRoot!.querySelectorAll(".step-connector");
    expect(connectors[0].classList.contains("completed")).to.be.true;
    expect(connectors[1].classList.contains("completed")).to.be.true;
  });

  it("handles empty steps array", async () => {
    const el = await fixture<StepIndicator>(html`
      <step-indicator .steps=${[]} .currentIndex=${0}></step-indicator>
    `);

    const steps = el.shadowRoot!.querySelectorAll(".step");
    expect(steps.length).to.equal(0);
  });

  describe("in the smallest window, zoomed to 200%", () => {
    beforeEach(() => setViewport({ width: 400, height: 375 }));
    afterEach(() => setViewport({ width: 800, height: 600 }));

    it("still names the current step", async () => {
      // What the header leaves it beside Back
      const el = await fixture<StepIndicator>(html`
        <step-indicator
          style="width: 270px"
          .steps=${longSteps}
          .currentIndex=${2}
        ></step-indicator>
      `);

      expect(shown(el)).to.deep.equal([
        false,
        false,
        true,
        false,
        false,
        false,
        false,
      ]);
      expect(rows(el)).to.equal(1);
      expect(el.scrollWidth).to.equal(el.clientWidth);
    });
  });
});
