import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import { emulateMedia } from "@web/test-runner-commands";
import "../../../src/components/scroll-row.js";
import type { ScrollRow } from "../../../src/components/scroll-row.js";

/**
 * A row 300px wide, of `count` links 100px wide each. The row itself is the
 * fixture: one around it would wait for a frame, which a page that isn't in
 * front, as while other test files run, doesn't draw.
 */
async function row(count: number, dir: "ltr" | "rtl" = "ltr") {
  const el = await fixture<ScrollRow>(
    html`<scroll-row dir=${dir} style="width: 300px">
      <div class="content" style="display: flex">
        ${Array.from({ length: count }, (_, index) => item(index))}
      </div>
    </scroll-row>`
  );
  // It measures once it rendered and observes what it holds
  await el.updateComplete;
  return el;
}

function item(index: number) {
  return html`<a href="#${index}" style="flex: none; width: 100px"
    >${index}</a
  >`;
}

/**
 * Scroll `el` to `left`, and tell it as the browser would. A page that isn't
 * in front, as while other test files run, only tells once it draws again.
 */
async function scrollTo(el: ScrollRow, left: number) {
  viewport(el).scrollLeft = left;
  viewport(el).dispatchEvent(new Event("scroll"));
  await el.updateComplete;
}

/** Click `button`, and tell the row it scrolled */
async function click(el: ScrollRow, button: HTMLButtonElement) {
  const before = viewport(el).scrollLeft;
  button.click();
  await waitUntil(
    () => viewport(el).scrollLeft !== before,
    "the button didn't scroll"
  );
  await scrollTo(el, viewport(el).scrollLeft);
}

const part = <T extends HTMLElement>(el: ScrollRow, selector: string) =>
  el.shadowRoot!.querySelector<T>(selector)!;
const back = (el: ScrollRow) => part<HTMLButtonElement>(el, ".back");
const forward = (el: ScrollRow) => part<HTMLButtonElement>(el, ".forward");
const viewport = (el: ScrollRow) => part(el, ".viewport");

describe("scroll-row", () => {
  // At once, so a page that doesn't draw meanwhile scrolls all the same
  before(() => emulateMedia({ reducedMotion: "reduce" }));
  after(() => emulateMedia({ reducedMotion: "no-preference" }));

  it("centers content that fits, with nothing to scroll", async () => {
    const el = await row(2);

    expect(back(el).hidden).to.be.true;
    expect(forward(el).hidden).to.be.true;
    expect(viewport(el).classList.contains("more-back")).to.be.false;
    expect(viewport(el).classList.contains("more-forward")).to.be.false;
    const content = el.querySelector(".content")!.getBoundingClientRect();
    const room = el.getBoundingClientRect();
    expect(content.left - room.left).to.be.closeTo(
      room.right - content.right,
      1
    );
  });

  it("fades out and offers to scroll on where more is out of sight", async () => {
    const el = await row(6);

    expect(back(el).hidden).to.be.true;
    expect(forward(el).hidden).to.be.false;
    expect(viewport(el).classList.contains("more-forward")).to.be.true;
    expect(viewport(el).classList.contains("more-back")).to.be.false;

    await click(el, forward(el));
    expect(viewport(el).scrollLeft).to.be.above(0);
    expect(back(el).hidden).to.be.false;
    expect(viewport(el).classList.contains("more-back")).to.be.true;

    // Until the end, where only the way back is left
    await scrollTo(el, viewport(el).scrollWidth);
    expect(forward(el).hidden).to.be.true;
    expect(back(el).hidden).to.be.false;
    expect(viewport(el).classList.contains("more-forward")).to.be.false;
  });

  it("scrolls toward the start of a right-to-left row, on its right", async () => {
    const el = await row(6, "rtl");

    expect(forward(el).hidden).to.be.false;
    expect(forward(el).getBoundingClientRect().left).to.be.below(
      el.getBoundingClientRect().left + 50
    );
    await click(el, forward(el));
    expect(viewport(el).scrollLeft).to.be.below(0);
    expect(back(el).hidden).to.be.false;
    expect(back(el).getBoundingClientRect().right).to.be.above(
      el.getBoundingClientRect().right - 50
    );
  });

  for (const dir of ["ltr", "rtl"] as const) {
    it(`fades out toward both edges midway along a ${dir} row`, async () => {
      const el = await row(6, dir);

      // Halfway, to the right in a left-to-right row, else to the left
      await scrollTo(el, (dir === "ltr" ? 1 : -1) * 150);
      expect(back(el).hidden).to.be.false;
      expect(forward(el).hidden).to.be.false;
      // Only the mask of both edges stops short of the far one
      expect(getComputedStyle(viewport(el)).maskImage).to.include("calc(");
    });
  }

  it("notices content that grows past its room", async () => {
    const el = await row(2);
    expect(forward(el).hidden).to.be.true;

    const content = el.querySelector(".content")!;
    for (const index of [2, 3, 4, 5]) {
      const link = document.createElement("a");
      link.href = `#${index}`;
      link.style.cssText = "flex: none; width: 100px";
      content.append(link);
    }
    await waitUntil(() => !forward(el).hidden, "it didn't notice");
  });

  it("leaves its buttons to the pointer, and its focus where it was", async () => {
    const el = await row(6);

    for (const button of [back(el), forward(el)]) {
      expect(button.tabIndex).to.equal(-1);
      expect(button.getAttribute("aria-hidden")).to.equal("true");
      const press = new MouseEvent("mousedown", { cancelable: true });
      button.dispatchEvent(press);
      expect(press.defaultPrevented).to.be.true;
    }
  });
});
