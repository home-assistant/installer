import { expect, fixture, html } from "@open-wc/testing";
import type WaDialog from "@home-assistant/webawesome/dist/components/dialog/dialog.js";
import { DialogBase } from "../../../src/components/dialog-base.js";

class TestDialog extends DialogBase {
  protected readonly dismissEvent = "test-dismiss";

  protected renderContent() {
    return html`
      ${this.renderTitle("Title")}
      <button slot="footer" @click=${this._onGo}>Go</button>
    `;
  }

  private _onGo() {
    this.choose("test-choice");
  }
}
customElements.define("dialog-base-test-dialog", TestDialog);

async function mount() {
  const el = await fixture<TestDialog>(
    html`<dialog-base-test-dialog open></dialog-base-test-dialog>`
  );
  const dialog = el.shadowRoot!.querySelector<WaDialog>("wa-dialog")!;
  const button = el.shadowRoot!.querySelector("button")!;
  const events: string[] = [];
  for (const type of ["test-choice", "test-dismiss"])
    el.addEventListener(type, () => events.push(type));
  // What wa-dialog fires as it starts to animate out, and once it has
  const hide = () =>
    dialog.dispatchEvent(
      new CustomEvent("wa-hide", { bubbles: true, composed: true })
    );
  const afterHide = () =>
    dialog.dispatchEvent(
      new CustomEvent("wa-after-hide", { bubbles: true, composed: true })
    );
  return { el, dialog, button, events, hide, afterHide };
}

describe("DialogBase", () => {
  it("keeps its box while wa-dialog animates out after an action", async () => {
    const { el, dialog, button, afterHide } = await mount();

    button.click();
    await el.updateComplete;
    await dialog.updateComplete;

    // Hidden now, the dialog would go without its hide animation
    expect(el.open).to.be.false;
    expect(el.hasAttribute("closing")).to.be.true;
    expect(getComputedStyle(el).display).to.equal("block");

    afterHide();
    expect(el.hasAttribute("closing")).to.be.false;
    expect(getComputedStyle(el).display).to.equal("none");
  });

  it("reports only the first click", async () => {
    const { button, events } = await mount();

    button.click();
    button.click();

    expect(events).to.deep.equal(["test-choice"]);
  });

  it("ignores a click once a dismissal started", async () => {
    const { el, button, events, hide, afterHide } = await mount();

    // Escape, then a click while the dialog animates out
    hide();
    button.click();
    expect(el.open).to.be.true;
    afterHide();

    expect(events).to.deep.equal(["test-dismiss"]);
    expect(el.open).to.be.false;
    expect(el.hasAttribute("closing")).to.be.false;
  });

  it("ignores wa-hide bubbling from nested slotted content", async () => {
    const { el, dialog } = await mount();

    const nested = document.createElement("div");
    dialog.appendChild(nested);
    nested.dispatchEvent(
      new CustomEvent("wa-hide", { bubbles: true, composed: true })
    );

    expect(el.hasAttribute("closing")).to.be.false;
  });

  it("lets go of its box when removed while animating out", async () => {
    const { el, hide } = await mount();

    hide();
    el.remove();

    // No wa-after-hide comes now, so it would cover the page once back
    expect(el.hasAttribute("closing")).to.be.false;
  });

  it("renders an info title by default, its icon hidden from screen readers", async () => {
    const { el } = await mount();

    const title = el.shadowRoot!.querySelector(".dialog-title")!;
    expect(title.classList.contains("info")).to.be.true;
    expect(
      title.querySelector(".info-icon")!.getAttribute("aria-hidden")
    ).to.equal("true");
    expect(title.textContent).to.contain("Title");
  });
});
