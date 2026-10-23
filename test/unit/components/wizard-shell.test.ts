import { expect, fixture, fixtureSync, html, oneEvent } from "@open-wc/testing";
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

  it("moves the focus a dialog gives back to a hidden Cancel to the step's heading", async () => {
    const step = document.createElement("div");
    step.attachShadow({ mode: "open" }).innerHTML =
      "<section><h2>Installing Home Assistant</h2></section>";
    const el = await fixture<WizardShell>(html`
      <wizard-shell hide-next>${step}</wizard-shell>
    `);
    const cancel = el.shadowRoot!.querySelector(
      ".footer-left wa-button"
    ) as HTMLElement & { updateComplete: Promise<unknown> };
    await cancel.updateComplete;
    cancel.focus();
    // "Stop the installation?", opened from Cancel
    const dialog = document.createElement("dialog");
    dialog.innerHTML = "<button>Stop installation</button>";
    el.parentElement!.append(dialog);
    dialog.showModal();
    dialog.querySelector("button")!.focus();

    // Stopping hides the buttons while the dialog closes
    el.hideFooter = true;
    await el.updateComplete;
    const heading = step.shadowRoot!.querySelector("h2")!;
    expect(step.shadowRoot!.activeElement === heading).to.be.false;

    dialog.close();
    dialog.dispatchEvent(
      new Event("wa-after-hide", { bubbles: true, composed: true })
    );
    expect(step.shadowRoot!.activeElement === heading).to.be.true;
    dialog.remove();
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

  it("puts the step in the main landmark, between a header and a footer", async () => {
    const el = await fixture<WizardShell>(html`<wizard-shell></wizard-shell>`);
    const root = el.shadowRoot!;

    expect(root.querySelector("header.header wa-button")).to.exist;
    expect(root.querySelector("main.content slot")).to.exist;
    expect(root.querySelector("footer.footer .footer-right wa-button")).to
      .exist;
  });

  it("names the flow in a hidden main heading, and leaves it out without one", async () => {
    const el = await fixture<WizardShell>(html`
      <wizard-shell flow-title="Proxmox server"></wizard-shell>
    `);
    const heading = el.shadowRoot!.querySelector("main h1");
    expect(heading!.textContent).to.equal("Proxmox server");
    expect(heading!.classList.contains("sr-only")).to.be.true;

    el.flowTitle = "";
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector("h1")).to.be.null;
  });

  describe("scrolling with the keyboard", () => {
    type Scrolling = { _checkScrolling(): void };

    async function shell(width: string, height: string) {
      const step = document.createElement("div");
      step.style.width = width;
      step.style.height = height;
      // fixture() would wait a frame for the plain wrapper
      const el = fixtureSync(html`
        <div style="height: 400px; width: 600px">
          <wizard-shell>${step}</wizard-shell>
        </div>
      `).querySelector("wizard-shell")!;
      await el.updateComplete;
      const main = el.shadowRoot!.querySelector("main")!;
      // Called as the observer would; a backgrounded test page gets no
      // resize callbacks
      const check = async () => {
        (el as unknown as Scrolling)._checkScrolling();
        await el.updateComplete;
      };
      return { el, step, main, check };
    }

    it("makes the step focusable only while it overflows", async () => {
      const { step, main, check } = await shell("auto", "10px");
      await check();
      expect(main.hasAttribute("tabindex")).to.be.false;

      step.style.height = "2000px";
      await check();
      expect(main.getAttribute("tabindex")).to.equal("0");

      step.style.height = "10px";
      await check();
      expect(main.hasAttribute("tabindex")).to.be.false;
    });

    it("counts a step that only overflows sideways", async () => {
      const { main, check } = await shell("2000px", "10px");
      await check();
      expect(main.getAttribute("tabindex")).to.equal("0");
    });

    it("doesn't count the pixel rounding can add", async () => {
      const { step, main, check } = await shell("auto", "10px");
      const style = getComputedStyle(main);
      const padding =
        parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      step.style.height = `${main.clientHeight - padding + 1}px`;
      await check();
      expect(main.scrollHeight - main.clientHeight).to.equal(1);
      expect(main.hasAttribute("tabindex")).to.be.false;
    });

    it("watches the step again when it is put back in the page", async () => {
      const { el, step } = await shell("auto", "10px");
      const observed: Element[] = [];
      (
        el as unknown as { _resizeObserver: Partial<ResizeObserver> }
      )._resizeObserver = {
        observe: (target: Element) => void observed.push(target),
        disconnect: () => (observed.length = 0),
      };
      const parent = el.parentElement!;

      el.remove();
      parent.append(el);

      expect(observed).to.include(step);
      expect(observed).to.include(el.shadowRoot!.querySelector("main")!);
    });
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
