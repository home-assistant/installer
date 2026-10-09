import {
  expect,
  fixture,
  fixtureSync,
  html,
  waitUntil,
} from "@open-wc/testing";
import { LitElement } from "lit";
import {
  ViewAccessibility,
  LiveStatus,
} from "../../../src/utils/view-accessibility.js";
import "../../../src/views/sbc/success-view.js";

class StatusTestView extends LitElement {
  static properties = {
    stageTitle: {},
    progress: {},
    bytesProcessed: {},
    error: {},
  };
  stageTitle = "";
  progress = 0;
  bytesProcessed = 0;
  error: string | null = null;
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
  static properties = { loading: { type: Boolean }, error: { type: String } };
  loading = false;
  error = "";
  protected readonly _accessibility = new ViewAccessibility(this);
  render() {
    return html`${this.loading ? "Loading" : html`<h2>Step heading</h2>`}
      ${this.error ? html`<p role="alert">${this.error}</p>` : ""}
      <input aria-label="Name" />`;
  }
}
customElements.define("focus-test-view", FocusTestView);

describe("view accessibility", () => {
  it("can prime after removal before its first render", async () => {
    const el = fixtureSync<StatusTestView>(
      html`<status-test-view stageTitle="Writing"></status-test-view>`
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
      html`<status-test-view stageTitle="Downloading"></status-test-view>`
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
      html`<status-test-view stageTitle="Downloading"></status-test-view>`
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
