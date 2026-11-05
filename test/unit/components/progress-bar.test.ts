import { expect, fixture, html } from "@open-wc/testing";
import "../../../src/components/progress-bar.js";
import type { ProgressBar } from "../../../src/components/progress-bar.js";

/** The `<wa-progress-bar>` this component wraps. */
const bar = (el: ProgressBar) =>
  el.shadowRoot!.querySelector("wa-progress-bar")!;

/** The ARIA progressbar inside it, once both have rendered. */
async function progressbar(el: ProgressBar) {
  await el.updateComplete;
  await bar(el).updateComplete;
  return bar(el).shadowRoot!.querySelector('[role="progressbar"]')!;
}

/**
 * Whether the indicator slides to the bar's value. Web Awesome sets its width
 * a frame after each update, and a backgrounded test page draws no frames, so
 * this sets it as Web Awesome would, after the width it had is computed.
 */
async function slides(el: ProgressBar) {
  await el.updateComplete;
  const inner = bar(el);
  await inner.updateComplete;
  const indicator =
    inner.shadowRoot!.querySelector<HTMLElement>('[part="indicator"]')!;
  getComputedStyle(indicator).getPropertyValue("width");
  inner.style.setProperty("--percentage", `${inner.value}%`);
  // The stripe a wait shows is an animation of its own
  return indicator
    .getAnimations()
    .some((animation) => animation instanceof CSSTransition);
}

describe("progress-bar", () => {
  it("renders with default progress (0)", async () => {
    const el = await fixture<ProgressBar>(html`<progress-bar></progress-bar>`);

    expect(bar(el)).to.exist;
    expect(bar(el).value).to.equal(0);
  });

  it("renders with 0% progress", async () => {
    const el = await fixture<ProgressBar>(html`
      <progress-bar progress="0"></progress-bar>
    `);

    expect(bar(el).value).to.equal(0);
  });

  it("renders with 50% progress", async () => {
    const el = await fixture<ProgressBar>(html`
      <progress-bar progress="50"></progress-bar>
    `);

    expect(bar(el).value).to.equal(50);
  });

  it("renders with 100% progress", async () => {
    const el = await fixture<ProgressBar>(html`
      <progress-bar progress="100"></progress-bar>
    `);

    expect(bar(el).value).to.equal(100);
  });

  it("clamps negative progress to 0%", async () => {
    const el = await fixture<ProgressBar>(html`
      <progress-bar progress="-10"></progress-bar>
    `);

    expect(bar(el).value).to.equal(0);
  });

  it("clamps progress above 100 to 100%", async () => {
    const el = await fixture<ProgressBar>(html`
      <progress-bar progress="150"></progress-bar>
    `);

    expect(bar(el).value).to.equal(100);
  });

  it("updates progress when property changes", async () => {
    const el = await fixture<ProgressBar>(html`<progress-bar></progress-bar>`);

    el.progress = 75;
    await el.updateComplete;

    expect(bar(el).value).to.equal(75);
  });

  it("renders in indeterminate mode", async () => {
    const el = await fixture<ProgressBar>(html`
      <progress-bar indeterminate></progress-bar>
    `);

    expect(bar(el).indeterminate).to.be.true;
  });

  it("indeterminate mode ignores the progress value", async () => {
    const el = await fixture<ProgressBar>(html`
      <progress-bar indeterminate progress="42"></progress-bar>
    `);

    expect(bar(el).indeterminate).to.be.true;
  });

  it("leaves out aria-valuenow while indeterminate", async () => {
    const el = await fixture<ProgressBar>(html`
      <progress-bar indeterminate progress="42"></progress-bar>
    `);

    // Web Awesome sets "0", which screen readers announce as 0%
    expect((await progressbar(el)).hasAttribute("aria-valuenow")).to.be.false;

    el.indeterminate = false;
    expect((await progressbar(el)).getAttribute("aria-valuenow")).to.equal(
      "42"
    );

    el.indeterminate = true;
    expect((await progressbar(el)).hasAttribute("aria-valuenow")).to.be.false;

    // A new value while still waiting doesn't bring it back, nor does Web
    // Awesome rendering again on its own
    el.progress = 60;
    expect((await progressbar(el)).hasAttribute("aria-valuenow")).to.be.false;
    bar(el).requestUpdate();
    expect((await progressbar(el)).hasAttribute("aria-valuenow")).to.be.false;
  });

  it("brings aria-valuenow back at 0%", async () => {
    // A wait that ends before the next stage reports any progress
    const el = await fixture<ProgressBar>(html`
      <progress-bar indeterminate></progress-bar>
    `);
    expect((await progressbar(el)).hasAttribute("aria-valuenow")).to.be.false;

    el.indeterminate = false;
    expect((await progressbar(el)).getAttribute("aria-valuenow")).to.equal("0");

    // And after a wait that ends where the last stage left off
    el.progress = 30;
    el.indeterminate = true;
    expect((await progressbar(el)).hasAttribute("aria-valuenow")).to.be.false;
    el.indeterminate = false;
    expect((await progressbar(el)).getAttribute("aria-valuenow")).to.equal(
      "30"
    );
  });

  it("slides forward, but shows a value that drops at once", async () => {
    const el = await fixture<ProgressBar>(html`
      <progress-bar progress="40"></progress-bar>
    `);
    expect(await slides(el)).to.be.false;

    const first = bar(el);
    el.progress = 100;
    expect(await slides(el)).to.be.true;
    expect(bar(el) === first).to.be.true;

    // The next stage counts from 0, so the bar must not slide back across the
    // track while the label counts up
    el.progress = 0;
    expect(await slides(el)).to.be.false;
    expect(bar(el) === first).to.be.false;
    expect(bar(el).value).to.equal(0);

    el.progress = 30;
    expect(await slides(el)).to.be.true;
  });

  it("shows the value at once when a wait starts or ends", async () => {
    const el = await fixture<ProgressBar>(html`
      <progress-bar progress="60"></progress-bar>
    `);
    await slides(el);
    const measured = bar(el);

    // Not from the value to the stripe
    el.indeterminate = true;
    expect(await slides(el)).to.be.false;
    const waiting = bar(el);
    expect(waiting === measured).to.be.false;
    expect(waiting.indeterminate).to.be.true;

    // A stage that drops back to 0 while still waiting keeps the same stripe
    // moving
    el.progress = 0;
    await slides(el);
    expect(bar(el) === waiting).to.be.true;

    // Nor from the stripe to the value
    el.indeterminate = false;
    el.progress = 20;
    expect(await slides(el)).to.be.false;
    expect(bar(el) === waiting).to.be.false;
    expect(bar(el).indeterminate).to.be.false;
    expect(bar(el).value).to.equal(20);
  });

  it("exposes a label to assistive technology", async () => {
    const el = await fixture<ProgressBar>(html`<progress-bar></progress-bar>`);

    // Falls back to a generic label so the bar is never announced unnamed.
    expect(bar(el).label).to.equal("Progress");

    el.label = "Writing image";
    await el.updateComplete;

    expect(bar(el).label).to.equal("Writing image");
  });
});
