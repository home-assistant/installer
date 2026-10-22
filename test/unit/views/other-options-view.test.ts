import { expect, fixture, html, oneEvent } from "@open-wc/testing";
import "../../../src/views/other-options-view.js";
import type { OtherOptionsView } from "../../../src/views/other-options-view.js";
import type { OptionCard } from "../../../src/components/option-card.js";
import { findByRole, fullA11ySnapshot } from "../helpers/a11y.js";
import { expectThemeLink } from "../helpers/link-style.js";
import { captureOpenedUrls, restoreTauriIpc, settle } from "../tauri-ipc.js";

const OPTIONS = [
  [
    "Home Assistant Container",
    "docker",
    "https://www.home-assistant.io/installation/linux#docker-compose",
  ],
  [
    "Synology NAS",
    "synology",
    "https://www.home-assistant.io/installation/alternative#synology-nas",
  ],
  [
    "QNAP NAS",
    "qnap",
    "https://www.home-assistant.io/installation/alternative#qnap-nas",
  ],
  [
    "Linux virtual machine",
    "linux",
    "https://www.home-assistant.io/installation/linux",
  ],
  [
    "Windows virtual machine",
    "windows",
    "https://www.home-assistant.io/installation/windows",
  ],
] as const;

const INSTALLATION_TYPES_URL =
  "https://www.home-assistant.io/installation/#about-installation-types";

function cards(el: OtherOptionsView) {
  return [...el.shadowRoot!.querySelectorAll<OptionCard>("option-card")];
}

describe("other-options-view", () => {
  afterEach(() => {
    restoreTauriIpc();
  });

  it("explains that these methods are outside the installer", async () => {
    const el = await fixture<OtherOptionsView>(
      html`<other-options-view></other-options-view>`
    );
    expect(el.shadowRoot!.querySelector("h1")!.textContent).to.contain(
      "Other installation methods"
    );
    const subtitle = el.shadowRoot!.querySelector(".subtitle")!;
    expect(subtitle.textContent).to.contain("not directly supported");
    const link = subtitle.querySelector("a")!;
    expect(link.textContent).to.equal("Compare installation types");
    expect(link.getAttribute("href")).to.equal(INSTALLATION_TYPES_URL);
    expect(link.getAttribute("target")).to.equal("_blank");
    expect(link.getAttribute("rel")).to.equal("noopener noreferrer");
    expectThemeLink(link);
  });

  it("lists each method with its own icon", async () => {
    const el = await fixture<OtherOptionsView>(
      html`<other-options-view></other-options-view>`
    );
    const shown = cards(el);
    expect(shown.map((card) => card.heading)).to.deep.equal(
      OPTIONS.map(([title]) => title)
    );
    expect(shown.map((card) => card.icon)).to.deep.equal(
      OPTIONS.map(([, icon]) => icon)
    );
    for (const card of shown) {
      expect(card.description).to.not.be.empty;
    }
  });

  for (const [title, , url] of OPTIONS) {
    it(`opens the ${title} guide outside the app`, async () => {
      const opened = captureOpenedUrls();
      const el = await fixture<OtherOptionsView>(
        html`<other-options-view></other-options-view>`
      );
      cards(el)
        .find((card) => card.heading === title)!
        .click();
      await settle();
      expect(opened).to.deep.equal([url]);
    });
  }

  it("opens the comparison outside the app instead of navigating", async () => {
    const opened = captureOpenedUrls();
    const el = await fixture<OtherOptionsView>(
      html`<other-options-view></other-options-view>`
    );
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    el.shadowRoot!.querySelector(".subtitle a")!.dispatchEvent(click);
    await settle();
    expect(click.defaultPrevented).to.be.true;
    expect(opened).to.deep.equal([INSTALLATION_TYPES_URL]);
  });

  it("goes back to the path selection", async () => {
    const el = await fixture<OtherOptionsView>(
      html`<other-options-view></other-options-view>`
    );
    const back = el.shadowRoot!.querySelector("wa-button")!;
    expect(back.textContent).to.contain("Back");

    setTimeout(() => back.click());
    const event = (await oneEvent(el, "navigate")) as CustomEvent;
    expect(event.detail).to.deep.equal({ view: "path-selection" });
  });

  it("names each method as a button without the external-link arrow", async () => {
    await fixture<OtherOptionsView>(
      html`<other-options-view></other-options-view>`
    );
    const names = findByRole(await fullA11ySnapshot(), "button").map(
      (button) => button.name ?? ""
    );
    for (const [title] of OPTIONS) {
      const name = names.find((candidate) => candidate.startsWith(title));
      expect(name, title).to.exist;
      expect(name).not.to.contain("↗");
    }
  });
});
