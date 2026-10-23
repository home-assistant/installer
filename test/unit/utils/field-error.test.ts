import { expect, fixture, html } from "@open-wc/testing";
import { LitElement } from "lit";
import { property } from "lit/decorators.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import "@home-assistant/webawesome/dist/components/input/input.js";
import {
  fieldError,
  fieldErrorStyles,
} from "../../../src/utils/field-error.js";
import { findByRole, fullA11ySnapshot } from "../helpers/a11y.js";

/** The error colour without the app's theme, which the unit tests don't load */
const ERROR_COLOR = "rgb(179, 5, 50)";

class FieldErrorTestView extends LitElement {
  static styles = fieldErrorStyles;
  @property() error?: string;
  @property({ type: Boolean }) disabled = false;
  render() {
    return html`<wa-input
      label="Name"
      ?disabled=${this.disabled}
      ${fieldError(this.error)}
    >
      <span slot="hint">${this.error ?? "Shown in the list"}</span>
    </wa-input>`;
  }
}
customElements.define("field-error-test-view", FieldErrorTestView);

async function mount() {
  const el = await fixture<FieldErrorTestView>(
    html`<field-error-test-view></field-error-test-view>`
  );
  const field = el.shadowRoot!.querySelector<WaInput>("wa-input")!;
  const setError = async (error: string | undefined) => {
    el.error = error;
    await el.updateComplete;
    await field.updateComplete;
  };
  await setError(undefined);
  return { el, field, setError };
}

describe("fieldError", () => {
  it("tells screen readers the field is invalid, and when it is fixed", async () => {
    const { field, setError } = await mount();
    const textbox = async () =>
      findByRole(await fullA11ySnapshot(), "textbox").find(
        (node) => node.name === "Name"
      )!;

    expect(field.input.getAttribute("aria-invalid")).to.equal("false");
    expect((await textbox()).invalid).to.be.undefined;

    await setError("Enter a name.");
    expect(field.validity.customError).to.be.true;
    expect(field.input.getAttribute("aria-invalid")).to.equal("true");
    const invalid = await textbox();
    expect(invalid.invalid).to.equal("true");
    expect(invalid.description).to.equal("Enter a name.");

    await setError(undefined);
    expect(field.validity.valid).to.be.true;
    expect(field.input.getAttribute("aria-invalid")).to.equal("false");
    expect((await textbox()).invalid).to.be.undefined;
  });

  it("shows an error in the error colour with an icon, not like a hint", async () => {
    const { el, field, setError } = await mount();
    const hint = el.shadowRoot!.querySelector<HTMLElement>('[slot="hint"]')!;
    const border = () =>
      getComputedStyle(field.shadowRoot!.querySelector('[part~="base"]')!)
        .borderTopColor;
    const icon = () => getComputedStyle(hint, "::before");

    expect(getComputedStyle(hint).color).not.to.equal(ERROR_COLOR);
    expect(border()).not.to.equal(ERROR_COLOR);
    expect(icon().content).to.equal("none");

    await setError("Enter a name.");
    expect(getComputedStyle(hint).color).to.equal(ERROR_COLOR);
    expect(border()).to.equal(ERROR_COLOR);
    expect(icon().content).to.equal('""');
    // A file, not a data: URL, which the app's CSP blocks
    expect(icon().maskImage).to.contain("/assets/icons/alert-circle.svg");
    expect(icon().backgroundColor).to.equal(ERROR_COLOR);
  });

  it("gives the error back once a disabled field is enabled again", async () => {
    const { el, field, setError } = await mount();
    await setError("Enter a name.");

    // Web Awesome doesn't validate a disabled field, and drops its error
    el.disabled = true;
    await el.updateComplete;
    await field.updateComplete;
    el.disabled = false;
    await el.updateComplete;
    await field.updateComplete;

    expect(field.validity.customError).to.be.true;
    expect(field.hasAttribute("custom-error")).to.be.true;
    expect(field.input.getAttribute("aria-invalid")).to.equal("true");
  });
});
