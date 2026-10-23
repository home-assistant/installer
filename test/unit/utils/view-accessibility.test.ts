import {
  expect,
  fixture,
  fixtureSync,
  html,
  waitUntil,
} from "@open-wc/testing";
import { LitElement } from "lit";
import { property } from "lit/decorators.js";
import {
  ViewAccessibility,
  LiveStatus,
} from "../../../src/utils/view-accessibility.js";
import "../../../src/views/sbc/success-view.js";

class StatusTestView extends LitElement {
  @property({ attribute: "stage-title" }) stageTitle = "";
  @property({ type: Number }) progress = 0;
  @property({ type: Number, attribute: "bytes-processed" }) bytesProcessed = 0;
  @property() error: string | null = null;
  protected readonly _accessibility = new ViewAccessibility(this);
  private readonly _status = new LiveStatus(this);
  render() {
    return html`<p role="status">
        ${this._status.ready && !this.error ? this.stageTitle : ""}
      </p>
      ${this.error
        ? html`<p role="alert">${this.error}</p>`
        : html`<h2>Installing</h2>`}`;
  }
}
customElements.define("status-test-view", StatusTestView);

class FocusTestView extends LitElement {
  @property({ type: Boolean }) loading = false;
  @property() error = "";
  protected readonly _accessibility = new ViewAccessibility(this);
  render() {
    return html`${this.loading ? "Loading" : html`<h2>Step heading</h2>`}
      ${this.error ? html`<p role="alert">${this.error}</p>` : ""}
      <input aria-label="Name" />`;
  }
}
customElements.define("focus-test-view", FocusTestView);

/** An error with its own retry, which a successful retry replaces with a list. */
class RetryTestView extends LitElement {
  @property() error = "";
  readonly accessibility = new ViewAccessibility(this);
  render() {
    return html`<h2>Step heading</h2>
      ${this.error
        ? html`<p role="alert">${this.error}</p>
            <button class="retry">Try again</button>`
        : html`<button class="refresh">Refresh</button>`}
      <input aria-label="Name" />`;
  }
}
customElements.define("retry-test-view", RetryTestView);

describe("view accessibility", () => {
  it("can prime after removal before its first render", async () => {
    const el = fixtureSync<StatusTestView>(
      html`<status-test-view stage-title="Writing"></status-test-view>`
    );
    const parent = el.parentNode!;
    el.remove();
    await el.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    parent.appendChild(el);
    await waitUntil(
      () =>
        el.shadowRoot!.querySelector('[role="status"]')!.textContent?.trim() ===
        "Writing",
      "reconnected status never became ready",
      { timeout: 3000 }
    );
  });
  it("starts with an empty status region, including after a pending mount is reconnected", async () => {
    const el = fixtureSync<StatusTestView>(
      html`<status-test-view stage-title="Downloading"></status-test-view>`
    );
    await el.updateComplete;
    const status = el.shadowRoot!.querySelector('[role="status"]')!;
    expect(status.textContent?.trim()).to.equal("");
    const parent = el.parentNode!;
    el.remove();
    parent.appendChild(el);
    await waitUntil(
      () => status.textContent?.trim() === "Downloading",
      "status never became ready",
      { timeout: 3000 }
    );
  });
  it("focuses a new heading once, then each new error", async () => {
    const el = await fixture<FocusTestView>(
      html`<focus-test-view></focus-test-view>`
    );
    expect(el.shadowRoot!.activeElement).to.equal(
      el.shadowRoot!.querySelector("h2")
    );
    const input = el.shadowRoot!.querySelector("input")!;
    input.focus();
    el.requestUpdate();
    await el.updateComplete;
    expect(el.shadowRoot!.activeElement).to.equal(input);
    el.error = "Failed";
    await el.updateComplete;
    expect(el.shadowRoot!.activeElement).to.equal(
      el.shadowRoot!.querySelector('[role="alert"]')
    );
    input.focus();
    el.requestUpdate();
    await el.updateComplete;
    expect(el.shadowRoot!.activeElement).to.equal(input);
    el.error = "Different failure";
    await el.updateComplete;
    expect(el.shadowRoot!.activeElement).to.equal(
      el.shadowRoot!.querySelector('[role="alert"]')
    );
  });

  it("lets a view continue from its own control after an error left with the focus", async () => {
    const el = await fixture<RetryTestView>(
      html`<retry-test-view error="Failed"></retry-test-view>`
    );
    const root = el.shadowRoot!;
    (root.querySelector(".retry") as HTMLElement).focus();
    el.error = "";
    await el.updateComplete;
    // Standing in, as the focused button went with the error
    expect(root.activeElement === root.querySelector("h2")).to.be.true;

    el.accessibility.restoreFocus(root.querySelector<HTMLElement>(".refresh"));
    expect(root.activeElement === root.querySelector(".refresh")).to.be.true;
  });

  it("leaves focus the user moved", async () => {
    const el = await fixture<RetryTestView>(
      html`<retry-test-view></retry-test-view>`
    );
    const root = el.shadowRoot!;
    const input = root.querySelector("input")!;
    input.focus();
    el.accessibility.restoreFocus(root.querySelector<HTMLElement>(".refresh"));
    expect(root.activeElement === input).to.be.true;
  });

  it("focuses a heading without drawing a focus ring", async () => {
    const el = await fixture<FocusTestView>(
      html`<focus-test-view></focus-test-view>`
    );
    const heading = el.shadowRoot!.querySelector("h2")!;
    expect(el.shadowRoot!.activeElement).to.equal(heading);
    expect(getComputedStyle(heading).outlineStyle).to.equal("none");
  });

  it("focuses a new view once the dialog that had the focus has closed", async () => {
    // A modal leaves the rest of the page inert, the new view included
    const dialog = document.createElement("dialog");
    dialog.innerHTML = "<button>Stop</button>";
    document.body.append(dialog);
    dialog.showModal();
    try {
      const el = await fixture<FocusTestView>(
        html`<focus-test-view></focus-test-view>`
      );
      const heading = el.shadowRoot!.querySelector("h2");
      expect(el.shadowRoot!.activeElement === heading).to.be.false;

      dialog.close();
      // As wa-dialog says once it has closed and given back the focus
      dialog.dispatchEvent(
        new Event("wa-after-hide", { bubbles: true, composed: true })
      );
      expect(el.shadowRoot!.activeElement === heading).to.be.true;
    } finally {
      dialog.remove();
    }
  });

  it("focuses an error after a dialog, over what the dialog gave back", async () => {
    const el = await fixture<FocusTestView>(
      html`<focus-test-view></focus-test-view>`
    );
    const input = el.shadowRoot!.querySelector("input")!;
    input.focus();
    const dialog = document.createElement("dialog");
    dialog.innerHTML = "<button>Stop</button>";
    el.parentElement!.append(dialog);
    dialog.showModal();
    dialog.querySelector("button")!.focus();

    el.error = "Failed";
    await el.updateComplete;
    const alert = el.shadowRoot!.querySelector('[role="alert"]');
    expect(el.shadowRoot!.activeElement === alert).to.be.false;

    dialog.close();
    // Back to what opened the dialog, the error not yet read out
    input.focus();
    dialog.dispatchEvent(
      new Event("wa-after-hide", { bubbles: true, composed: true })
    );
    expect(el.shadowRoot!.activeElement === alert).to.be.true;

    // Waits only for that dialog: later ones leave the focus alone
    input.focus();
    dialog.showModal();
    dialog.close();
    input.focus();
    dialog.dispatchEvent(
      new Event("wa-after-hide", { bubbles: true, composed: true })
    );
    expect(el.shadowRoot!.activeElement === input).to.be.true;
  });

  it("does not steal focus when a delayed heading arrives", async () => {
    const el = await fixture<FocusTestView>(
      html`<focus-test-view .loading=${true}></focus-test-view>`
    );
    const input = el.shadowRoot!.querySelector("input")!;
    input.focus();
    el.loading = false;
    await el.updateComplete;
    expect(el.shadowRoot!.activeElement).to.equal(input);
  });

  it("returns focus after an external retry without interrupting form edits", async () => {
    const el = await fixture<FocusTestView>(
      html`<focus-test-view></focus-test-view>`
    );
    const button = document.createElement("button");
    el.parentElement!.append(button);
    el.error = "Failed";
    await el.updateComplete;
    button.focus();
    el.error = "";
    await el.updateComplete;
    expect(el.shadowRoot!.activeElement?.tagName).to.equal("H2");
    el.error = "Failed again";
    await el.updateComplete;
    const input = el.shadowRoot!.querySelector("input")!;
    input.focus();
    el.error = "";
    await el.updateComplete;
    expect(el.shadowRoot!.activeElement).to.equal(input);
  });

  it("announces only the stage, preserving focus during byte updates", async () => {
    const el = await fixture<StatusTestView>(
      html`<status-test-view stage-title="Downloading"></status-test-view>`
    );
    const status = el.shadowRoot!.querySelector('[role="status"]')!;
    await waitUntil(
      () => status.textContent?.trim() === "Downloading",
      "status never became ready",
      { timeout: 3000 }
    );
    el.progress = 25;
    el.bytesProcessed = 100;
    await el.updateComplete;
    expect(status.textContent?.trim()).to.equal("Downloading");
    el.stageTitle = "Extracting";
    await el.updateComplete;
    expect(status.textContent?.trim()).to.equal("Extracting");
    el.error = "Cannot write this drive";
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('[role="status"]')).to.equal(status);
    expect(status.textContent?.trim()).to.equal("");
    expect(el.shadowRoot!.activeElement?.getAttribute("role")).to.equal(
      "alert"
    );
    el.error = null;
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('[role="status"]')).to.equal(status);
    expect(status.textContent?.trim()).to.equal("Extracting");
    expect(el.shadowRoot!.activeElement?.tagName).to.equal("H2");
  });

  it("exposes completion as an alert and focus target", async () => {
    const el = await fixture<LitElement>(html`<success-view></success-view>`);
    // The shared success layout owns the heading and its focus
    const success =
      el.shadowRoot!.querySelector<LitElement>("install-success")!;
    await success.updateComplete;
    const focused = success.shadowRoot!.activeElement;
    expect(focused?.textContent).to.equal("You're all set!");
    expect(focused?.tagName).to.equal("H2");
    expect(focused?.parentElement?.getAttribute("role")).to.equal("alert");
  });
});
