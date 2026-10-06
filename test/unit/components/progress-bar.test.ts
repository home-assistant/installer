import { expect, fixture, html } from "@open-wc/testing";
import "../../../src/components/progress-bar.js";
import type { ProgressBar } from "../../../src/components/progress-bar.js";

/** The `<wa-progress-bar>` this component wraps. */
const bar = (el: ProgressBar) =>
  el.shadowRoot!.querySelector("wa-progress-bar") as HTMLElement & {
    value: number;
    indeterminate: boolean;
    label: string;
  };

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

  it("renders with error state", async () => {
    const el = await fixture<ProgressBar>(html`
      <progress-bar error progress="30"></progress-bar>
    `);

    expect(bar(el).classList.contains("error")).to.be.true;
  });

  it("does not show error class when error is false", async () => {
    const el = await fixture<ProgressBar>(html`
      <progress-bar progress="30"></progress-bar>
    `);

    expect(bar(el).classList.contains("error")).to.be.false;
  });

  it("can toggle error state", async () => {
    const el = await fixture<ProgressBar>(html`
      <progress-bar progress="30"></progress-bar>
    `);

    expect(bar(el).classList.contains("error")).to.be.false;

    el.error = true;
    await el.updateComplete;

    expect(bar(el).classList.contains("error")).to.be.true;
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
