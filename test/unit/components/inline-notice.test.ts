import { expect, fixture, html } from "@open-wc/testing";
import "../../../src/components/inline-notice.js";
import type { InlineNotice } from "../../../src/components/inline-notice.js";

const icon = (el: InlineNotice) => el.shadowRoot!.querySelector(".icon")!;

describe("inline-notice", () => {
  it("is a warning with a decorative icon by default", async () => {
    const el = await fixture<InlineNotice>(html`
      <inline-notice><p>Back up your files first.</p></inline-notice>
    `);

    // Reflected, so views and e2e selectors can tell the variants apart
    expect(el.getAttribute("variant")).to.equal("warning");
    expect(icon(el).textContent).to.equal("⚠️");
    expect(icon(el).getAttribute("aria-hidden")).to.equal("true");
    expect(el.textContent).to.contain("Back up your files first.");
  });

  it("uses the error tint and a custom icon when asked", async () => {
    const el = await fixture<InlineNotice>(html`
      <inline-notice variant="error" icon="🔌">
        <p>The drive is gone.</p>
      </inline-notice>
    `);

    expect(icon(el).textContent).to.equal("🔌");
    const warning = await fixture<InlineNotice>(
      html`<inline-notice></inline-notice>`
    );
    expect(getComputedStyle(el).backgroundColor).not.to.equal(
      getComputedStyle(warning).backgroundColor
    );
  });

  it("stacks its paragraphs without their default margins", async () => {
    const el = await fixture<InlineNotice>(html`
      <inline-notice>
        <p>First</p>
        <p>Second</p>
      </inline-notice>
    `);

    const [first, second] = el.querySelectorAll("p");
    expect(getComputedStyle(first).marginTop).to.equal("0px");
    const gap =
      second.getBoundingClientRect().top - first.getBoundingClientRect().bottom;
    expect(gap).to.be.greaterThan(0);
  });
});
