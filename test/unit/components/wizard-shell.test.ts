import { expect, fixture, html, oneEvent } from "@open-wc/testing";
import "../../../src/components/wizard-shell.js";
import type { WizardShell } from "../../../src/components/wizard-shell.js";
import { wizardState } from "../../../src/state/wizard-state.js";

describe("wizard-shell", () => {
  beforeEach(() => {
    wizardState.reset();
    wizardState.startFlow("sbc");
  });

  afterEach(() => {
    wizardState.reset();
  });

  it("renders the header with back button", async () => {
    const el = await fixture<WizardShell>(html`<wizard-shell></wizard-shell>`);

    const backButton = el.shadowRoot!.querySelector(".header wa-button");
    expect(backButton).to.exist;
    expect(backButton!.textContent).to.include("Back");
  });

  it("renders the step indicator", async () => {
    const el = await fixture<WizardShell>(html`<wizard-shell></wizard-shell>`);

    const stepIndicator = el.shadowRoot!.querySelector("step-indicator");
    expect(stepIndicator).to.exist;
  });

  it("renders the cancel button", async () => {
    const el = await fixture<WizardShell>(html`<wizard-shell></wizard-shell>`);

    const cancelButton = el.shadowRoot!.querySelector(".footer-left wa-button");
    expect(cancelButton).to.exist;
    expect(cancelButton!.textContent).to.include("Cancel");
  });

  it("renders slotted content", async () => {
    const el = await fixture<WizardShell>(html`
      <wizard-shell>
        <div id="test-content">Test Content</div>
      </wizard-shell>
    `);

    const slot = el.shadowRoot!.querySelector("slot");
    expect(slot).to.exist;
  });

  it("renders the footer with next button", async () => {
    const el = await fixture<WizardShell>(html`<wizard-shell></wizard-shell>`);

    const nextButton = el.shadowRoot!.querySelector(".footer-right wa-button");
    expect(nextButton).to.exist;
    expect(nextButton!.textContent).to.include("Next");
  });

  it("uses custom next label", async () => {
    const el = await fixture<WizardShell>(html`
      <wizard-shell next-label="Continue"></wizard-shell>
    `);

    const nextButton = el.shadowRoot!.querySelector(".footer-right wa-button");
    expect(nextButton!.textContent).to.include("Continue");
  });

  it("leaves the flow when Back is clicked on the first step", async () => {
    const el = await fixture<WizardShell>(html`<wizard-shell></wizard-shell>`);

    const backButton = el.shadowRoot!.querySelector(
      ".header wa-button"
    ) as HTMLButtonElement;
    expect(backButton.disabled).to.be.false;

    let wentBack = false;
    el.addEventListener("wizard-back", () => (wentBack = true));
    setTimeout(() => backButton.click());
    await oneEvent(el, "wizard-exit");
    expect(wentBack).to.be.false;
    expect(wizardState.getState().currentFlow).to.equal("sbc");
  });

  it("leaves out Cancel when asked, keeping Next", async () => {
    const el = await fixture<WizardShell>(
      html`<wizard-shell hide-cancel next-label="Done"></wizard-shell>`
    );

    expect(el.shadowRoot!.querySelector(".footer-left wa-button")).to.be.null;
    expect(
      el
        .shadowRoot!.querySelector(".footer-right wa-button")!
        .textContent!.trim()
    ).to.equal("Done");
  });

  it("keeps Back disabled while hidden", async () => {
    const el = await fixture<WizardShell>(
      html`<wizard-shell hide-back></wizard-shell>`
    );

    const backButton = el.shadowRoot!.querySelector(
      ".header wa-button"
    ) as HTMLButtonElement;
    expect(backButton.disabled).to.be.true;
  });

  it("enables back button after first step", async () => {
    wizardState.nextStep();

    const el = await fixture<WizardShell>(html`<wizard-shell></wizard-shell>`);

    const backButton = el.shadowRoot!.querySelector(
      ".header wa-button"
    ) as HTMLButtonElement;
    expect(backButton.disabled).to.be.false;
  });

  it("dispatches wizard-cancel event", async () => {
    const el = await fixture<WizardShell>(html`<wizard-shell></wizard-shell>`);

    const cancelButton = el.shadowRoot!.querySelector(
      ".footer-left wa-button"
    ) as HTMLButtonElement;

    setTimeout(() => cancelButton.click());
    const event = await oneEvent(el, "wizard-cancel");
    expect(event).to.exist;
  });

  it("dispatches wizard-next event", async () => {
    const el = await fixture<WizardShell>(html`<wizard-shell></wizard-shell>`);

    const nextButton = el.shadowRoot!.querySelector(
      ".footer-right wa-button"
    ) as HTMLButtonElement;

    setTimeout(() => nextButton.click());
    const event = await oneEvent(el, "wizard-next");
    expect(event).to.exist;
  });

  it("ignores the second click of a double-click", async () => {
    wizardState.nextStep(); // Go to step 2, so Back steps back instead of leaving

    const el = await fixture<WizardShell>(html`<wizard-shell></wizard-shell>`);
    const events: string[] = [];
    el.addEventListener("wizard-next", () => events.push("next"));
    el.addEventListener("wizard-back", () => events.push("back"));

    for (const selector of [".footer-right wa-button", ".header wa-button"]) {
      el.shadowRoot!.querySelector(selector)!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, composed: true, detail: 2 })
      );
    }

    expect(events).to.deep.equal([]);
    expect(wizardState.getState().currentStepIndex).to.equal(1);
  });

  it("dispatches wizard-back event and goes to previous step", async () => {
    wizardState.nextStep(); // Go to step 2

    const el = await fixture<WizardShell>(html`<wizard-shell></wizard-shell>`);

    const backButton = el.shadowRoot!.querySelector(
      ".header wa-button"
    ) as HTMLButtonElement;

    setTimeout(() => backButton.click());
    const event = await oneEvent(el, "wizard-back");
    expect(event).to.exist;
    expect(wizardState.getState().currentStepIndex).to.equal(0);
  });

  it("hides the footer's buttons in place when hideFooter is true", async () => {
    const el = await fixture<WizardShell>(html`<wizard-shell></wizard-shell>`);
    const footer = el.shadowRoot!.querySelector(".footer") as HTMLElement;
    const height = footer.offsetHeight;

    el.hideFooter = true;
    await el.updateComplete;

    // The same footer, so the step above it doesn't move
    expect(el.shadowRoot!.querySelector(".footer") === footer).to.be.true;
    expect(footer.offsetHeight).to.equal(height);
    for (const button of footer.querySelectorAll("wa-button")) {
      expect(getComputedStyle(button).visibility).to.equal("hidden");
    }
  });

  it("moves the focus from a hiding Cancel to the step's heading", async () => {
    const step = document.createElement("div");
    step.attachShadow({ mode: "open" }).innerHTML =
      "<section><h2>Creating the virtual machine</h2></section>";
    const el = await fixture<WizardShell>(html`
      <wizard-shell hide-next>${step}</wizard-shell>
    `);
    const cancel = el.shadowRoot!.querySelector(
      ".footer-left wa-button"
    ) as HTMLElement;
    await (cancel as HTMLElement & { updateComplete: Promise<unknown> })
      .updateComplete;
    cancel.focus();
    expect(el.shadowRoot!.activeElement === cancel).to.be.true;

    el.hideFooter = true;
    await el.updateComplete;

    const heading = step.shadowRoot!.querySelector("h2")!;
    expect(step.shadowRoot!.activeElement === heading).to.be.true;
  });

  it("leaves the focus alone when the buttons hide without it", async () => {
    const step = document.createElement("div");
    step.attachShadow({ mode: "open" }).innerHTML =
      "<h2>Installing</h2><input />";
    const el = await fixture<WizardShell>(html`
      <wizard-shell>${step}</wizard-shell>
    `);
    const input = step.shadowRoot!.querySelector("input")!;
    input.focus();

    el.hideFooter = true;
    await el.updateComplete;

    expect(step.shadowRoot!.activeElement === input).to.be.true;
  });

  it("keeps a busy Next focusable, says what it waits for, and takes no clicks", async () => {
    const el = await fixture<WizardShell>(html`<wizard-shell></wizard-shell>`);
    const next = el.shadowRoot!.querySelector(
      ".footer-right wa-button"
    ) as HTMLElement & { updateComplete: Promise<unknown> };
    const status = el.shadowRoot!.querySelector("[aria-live=polite]")!;
    await next.updateComplete;
    next.focus();
    // Mounted empty, so the busy label is announced as it arrives
    expect(status.textContent).to.equal("");

    el.nextBusy = true;
    el.nextLabel = "Connecting...";
    await el.updateComplete;
    await next.updateComplete;

    expect(next.hasAttribute("loading")).to.be.true;
    expect(next.hasAttribute("disabled")).to.be.false;
    expect(el.shadowRoot!.activeElement === next).to.be.true;
    expect(
      next.shadowRoot!.querySelector("button")!.getAttribute("aria-busy")
    ).to.equal("true");
    expect(next.textContent!.trim()).to.equal("Connecting...");
    expect(status.textContent).to.equal("Connecting...");

    let nexts = 0;
    el.addEventListener("wizard-next", () => nexts++);
    next.click();
    expect(nexts).to.equal(0);

    el.nextBusy = false;
    el.nextLabel = "Next";
    await el.updateComplete;
    await next.updateComplete;
    expect(status.textContent).to.equal("");
    next.click();
    expect(nexts).to.equal(1);
  });

  it("hides next button when hideNext is true", async () => {
    const el = await fixture<WizardShell>(html`
      <wizard-shell hide-next></wizard-shell>
    `);

    const nextButton = el.shadowRoot!.querySelector(".footer-right wa-button");
    expect(nextButton).to.be.null;
  });

  it("disables next button when nextDisabled is true", async () => {
    const el = await fixture<WizardShell>(html`
      <wizard-shell next-disabled></wizard-shell>
    `);

    const nextButton = el.shadowRoot!.querySelector(
      ".footer-right wa-button"
    ) as HTMLButtonElement;
    expect(nextButton.disabled).to.be.true;
  });
});
