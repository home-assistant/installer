import { expect, fixtureSync } from "@open-wc/testing";
import { html } from "lit";
import { setLanguage } from "../../../src/localization/localize.js";
import { renderExternalLink } from "../../../src/utils/external-link.js";
import { captureOpenedUrls, restoreTauriIpc, settle } from "../tauri-ipc.js";

const URL = "https://www.home-assistant.io/installation/";

function linkIn(template: unknown) {
  const el = fixtureSync<HTMLDivElement>(html`<div>${template}</div>`);
  return el.querySelector("a")!;
}

describe("utils/external-link", () => {
  afterEach(() => {
    restoreTauriIpc();
    setLanguage("en");
  });

  it("falls back to a new, unrelated page when the click isn't handled", () => {
    const link = linkIn(renderExternalLink(URL, "Installation guide"));
    expect(link.getAttribute("href")).to.equal(URL);
    expect(link.getAttribute("target")).to.equal("_blank");
    expect(link.getAttribute("rel")).to.equal("noopener noreferrer");
    expect(link.hasAttribute("class")).to.be.false;
  });

  it("opens the page through the opener and leaves the installer where it is", async () => {
    const opened = captureOpenedUrls();
    const link = linkIn(renderExternalLink(URL, "Installation guide"));
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    await settle();
    expect(click.defaultPrevented).to.be.true;
    expect(opened).to.deep.equal([URL]);
  });

  it("opens it from the hint too, which is inside the link", async () => {
    const opened = captureOpenedUrls();
    const link = linkIn(renderExternalLink(URL, "Installation guide"));
    link.querySelector("span")!.click();
    await settle();
    expect(opened).to.deep.equal([URL]);
  });

  it("tells a screen reader that the link opens in the browser", () => {
    const link = linkIn(renderExternalLink(URL, "Installation guide"));
    expect(link.textContent).to.equal(
      "Installation guide Opens in your browser."
    );
  });

  it("keeps the hint out of sight, wherever it is rendered", () => {
    const link = linkIn(renderExternalLink(URL, "Installation guide"));
    const style = getComputedStyle(link.querySelector("span")!);
    expect(style.position).to.equal("absolute");
    expect(style.width).to.equal("1px");
    expect(style.height).to.equal("1px");
    // The link is as wide as its text alone
    const plain = linkIn(
      renderExternalLink(URL, "Installation guide", { hint: false })
    );
    expect(link.getBoundingClientRect().width).to.equal(
      plain.getBoundingClientRect().width
    );
  });

  it("says it in the user's language", () => {
    setLanguage("nl", { "common.opens_in_browser": "Opent in je browser." });
    const link = linkIn(renderExternalLink(URL, "Installatiegids"));
    expect(link.textContent).to.equal("Installatiegids Opent in je browser.");
  });

  it("leaves the hint out where the sentence already says it", () => {
    const link = linkIn(
      renderExternalLink(URL, "homeassistant.local", { hint: false })
    );
    expect(link.textContent).to.equal("homeassistant.local");
    expect(link.querySelector("span")).to.be.null;
  });

  it("takes a class for the view's own styling", () => {
    const link = linkIn(
      renderExternalLink(URL, "Learn more", { className: "learn-more" })
    );
    expect(link.getAttribute("class")).to.equal("learn-more");
  });

  it("wraps more than text, like a logo", () => {
    const link = linkIn(
      renderExternalLink(
        URL,
        html`<img alt="Open Home Foundation" src="data:," />`
      )
    );
    expect(link.querySelector("img")!.alt).to.equal("Open Home Foundation");
    expect(link.querySelector("span")!.textContent).to.equal(
      " Opens in your browser."
    );
  });
});
