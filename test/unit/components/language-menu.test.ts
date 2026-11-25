import { expect, fixture, html } from "@open-wc/testing";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import type WaRadioGroup from "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import type { LanguageMenu } from "../../../src/components/language-menu.js";
import {
  getLanguage,
  setLanguage,
} from "../../../src/localization/localize.js";

// More languages than the menu lists without a search. They stand in for
// Vite's import.meta.glob, so they have to be in place before the menu loads.
const TAGS = ["de", "fr", "nl", "pl", "es", "it", "pt", "sv", "da", "nb", "fi"];

async function renderMenu() {
  const menu = await fixture<LanguageMenu>(
    html`<language-menu></language-menu>`
  );
  const root = menu.shadowRoot!;
  const search = root.querySelector<WaInput>("wa-input")!;
  return {
    menu,
    search,
    languages: root.querySelector<WaRadioGroup>("wa-radio-group")!,
    listed: () =>
      Array.from(root.querySelectorAll("wa-radio"), (radio) =>
        radio.textContent!.trim()
      ),
    find: async (text: string) => {
      search.value = text;
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await menu.updateComplete;
    },
  };
}

describe("language-menu", () => {
  before(async () => {
    Object.assign(globalThis, {
      translations: () =>
        Object.fromEntries(
          TAGS.map((tag) => [`./${tag}.json`, async () => ({})])
        ),
    });
    await import("../../../src/components/language-menu.js");
  });

  afterEach(() => {
    setLanguage("en");
    document.documentElement.lang = "";
  });

  it("lists each language by its own name, at the one shown", async () => {
    const { languages, listed } = await renderMenu();

    expect(languages.label).to.equal("Language");
    expect(languages.value).to.equal("en");
    expect(listed()).to.deep.equal([
      "Dansk",
      "Deutsch",
      "English",
      "Español",
      "Français",
      "Italiano",
      "Nederlands",
      "Norsk bokmål",
      "Polski",
      "Português",
      "Suomi",
      "Svenska",
    ]);
  });

  it("finds a language by its own name, without accents", async () => {
    const { search, listed, find } = await renderMenu();

    expect(search.accessibleLabel).to.equal("Search languages");
    await find("francais");

    expect(listed()).to.deep.equal(["Français"]);
  });

  it("finds a language by its name in the language shown", async () => {
    const { listed, find } = await renderMenu();

    await find("German");

    expect(listed()).to.deep.equal(["Deutsch"]);
  });

  it("says when no language matches", async () => {
    const { menu, listed, find } = await renderMenu();

    await find("Klingon");

    expect(listed()).to.deep.equal([]);
    expect(
      menu.shadowRoot!.querySelector(".none")!.textContent!.trim()
    ).to.equal("No language matches");
  });

  it("shows the app in the language chosen", async () => {
    const { languages } = await renderMenu();

    languages.value = "fi";
    languages.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve));

    expect(getLanguage()).to.equal("fi");
    expect(document.documentElement.lang).to.equal("fi");
  });
});
