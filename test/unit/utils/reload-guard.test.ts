import { expect, fixture, html } from "@open-wc/testing";
import { preventReload } from "../../../src/utils/reload-guard.js";

/** Whether the webview would still act on `event` sent from `from` */
function goesThrough(from: Element, event: Event): boolean {
  return from.dispatchEvent(event);
}

const key = (init: KeyboardEventInit) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

const contextMenu = () =>
  new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    composed: true,
  });

describe("preventReload", () => {
  let page: HTMLElement;

  beforeEach(async () => {
    page = await fixture(html`
      <div>
        <p>Some text</p>
        <input />
        <textarea></textarea>
        <div contenteditable="true"></div>
      </div>
    `);
    preventReload(page);
  });

  afterEach(() => document.getSelection()?.removeAllRanges());

  for (const [name, init] of [
    ["F5", { key: "F5" }],
    ["Shift+F5", { key: "F5", shiftKey: true }],
    ["the refresh key", { key: "BrowserRefresh" }],
    ["Ctrl+R", { key: "r", code: "KeyR", ctrlKey: true }],
    ["Ctrl+Shift+R", { key: "R", code: "KeyR", ctrlKey: true, shiftKey: true }],
    ["Cmd+R", { key: "r", code: "KeyR", metaKey: true }],
    // Russian: the key types another letter, and still reloads
    ["Ctrl+R in another layout", { key: "к", code: "KeyR", ctrlKey: true }],
  ] as const) {
    it(`drops ${name}`, () => {
      expect(goesThrough(page.querySelector("input")!, key(init))).to.be.false;
    });
  }

  for (const [name, init] of [
    ["R", { key: "r", code: "KeyR" }],
    ["Ctrl+C", { key: "c", code: "KeyC", ctrlKey: true }],
    ["Enter", { key: "Enter", code: "Enter" }],
  ] as const) {
    it(`leaves ${name} alone`, () => {
      expect(goesThrough(page.querySelector("input")!, key(init))).to.be.true;
    });
  }

  it("drops the page's own context menu, which has Reload", () => {
    expect(goesThrough(page.querySelector("p")!, contextMenu())).to.be.false;
  });

  for (const field of ["input", "textarea", "[contenteditable]"]) {
    it(`keeps the context menu of ${field}, for Copy and Paste`, () => {
      expect(goesThrough(page.querySelector(field)!, contextMenu())).to.be.true;
    });
  }

  it("keeps the context menu on selected text, for Copy", () => {
    const text = page.querySelector("p")!;
    document.getSelection()!.selectAllChildren(text);

    expect(goesThrough(text, contextMenu())).to.be.true;
  });

  it("keeps the context menu of a field in a shadow root", async () => {
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" }).innerHTML = "<input />";
    page.append(host);

    const field = host.shadowRoot!.querySelector("input")!;
    expect(goesThrough(field, contextMenu())).to.be.true;
  });
});
