import { expect, fixture, html, oneEvent } from "@open-wc/testing";
import type WaSelect from "@home-assistant/webawesome/dist/components/select/select.js";
import "../../../src/views/welcome-view.js";
import type { WelcomeView } from "../../../src/views/welcome-view.js";
import {
  getLanguage,
  setLanguage,
} from "../../../src/localization/localize.js";

describe("welcome-view", () => {
  afterEach(() => {
    setLanguage("en");
    document.documentElement.lang = "";
  });
  it("renders the Home Assistant logo", async () => {
    const el = await fixture<WelcomeView>(html`<welcome-view></welcome-view>`);

    const lightLogo = el.shadowRoot!.querySelector(".logo-light");
    const darkLogo = el.shadowRoot!.querySelector(".logo-dark");

    expect(lightLogo).to.exist;
    expect(darkLogo).to.exist;
    expect(lightLogo!.getAttribute("src")).to.include(
      "home-assistant-logo-light.svg"
    );
    expect(darkLogo!.getAttribute("src")).to.include(
      "home-assistant-logo-dark.svg"
    );
  });

  it("says what the installer does in one line", async () => {
    const el = await fixture<WelcomeView>(html`<welcome-view></welcome-view>`);

    const intro = el.shadowRoot!.querySelector(".intro");
    expect(intro!.textContent).to.include("sets up Home Assistant");
  });

  it("renders the Let's go button", async () => {
    const el = await fixture<WelcomeView>(html`<welcome-view></welcome-view>`);

    const button = el.shadowRoot!.querySelector("wa-button");
    expect(button).to.exist;
    expect(button!.textContent).to.include("Let's go");
  });

  it("dispatches navigate event when Let's go is clicked", async () => {
    const el = await fixture<WelcomeView>(html`<welcome-view></welcome-view>`);

    const button = el.shadowRoot!.querySelector("wa-button")!;

    setTimeout(() => button.click());
    const event = await oneEvent(el, "navigate");

    expect(event).to.exist;
    expect((event as CustomEvent).detail.view).to.equal("path-selection");
  });

  it("renders the learn more link", async () => {
    const el = await fixture<WelcomeView>(html`<welcome-view></welcome-view>`);

    const learnMore = el.shadowRoot!.querySelector(".learn-more");
    expect(learnMore).to.exist;
    expect(learnMore!.getAttribute("href")).to.include("home-assistant.io");
    expect(learnMore!.getAttribute("target")).to.equal("_blank");
    expect(learnMore!.getAttribute("rel")).to.equal("noopener noreferrer");
  });

  it("intercepts the learn more link click", async () => {
    const el = await fixture<WelcomeView>(html`<welcome-view></welcome-view>`);

    const learnMore = el.shadowRoot!.querySelector(
      ".learn-more"
    ) as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });

    expect(learnMore.dispatchEvent(event)).to.be.false;
    expect(event.defaultPrevented).to.be.true;
  });

  it("renders the OHF logo with light and dark variants", async () => {
    const el = await fixture<WelcomeView>(html`<welcome-view></welcome-view>`);

    const ohfLink = el.shadowRoot!.querySelector(".ohf-link");
    const lightLogo = el.shadowRoot!.querySelector(".ohf-logo-light");
    const darkLogo = el.shadowRoot!.querySelector(".ohf-logo-dark");

    expect(ohfLink).to.exist;
    expect(ohfLink!.getAttribute("href")).to.include("openhomefoundation.org");
    expect(lightLogo).to.exist;
    expect(darkLogo).to.exist;
  });

  it("puts Report a problem and Learn more in the footer", async () => {
    const el = await fixture<WelcomeView>(html`<welcome-view></welcome-view>`);

    const footer = el.shadowRoot!.querySelector(".welcome-footer")!;
    expect(footer.querySelector("diagnostics-actions.report")).to.exist;
    expect(footer.querySelector(".learn-more")!.textContent!.trim()).to.equal(
      "Learn more Opens in your browser."
    );
  });

  it("offers each shipped language by its own name", async () => {
    const el = await fixture<WelcomeView>(html`<welcome-view></welcome-view>`);

    const select = el.shadowRoot!.querySelector<WaSelect>("wa-select")!;
    expect(select.label).to.equal("Language");
    expect(select.value).to.equal("en");
    const options = Array.from(select.querySelectorAll("wa-option"));
    expect(options.map((option) => option.textContent)).to.deep.equal([
      "Deutsch",
      "English",
    ]);
    expect(options.map((option) => option.lang)).to.deep.equal(["de", "en"]);
  });

  it("selects the shipped language a regional one uses", async () => {
    setLanguage("de-AT");
    const el = await fixture<WelcomeView>(html`<welcome-view></welcome-view>`);

    expect(el.shadowRoot!.querySelector<WaSelect>("wa-select")!.value).to.equal(
      "de"
    );
  });

  it("shows the page in the chosen language", async () => {
    const el = await fixture<WelcomeView>(html`<welcome-view></welcome-view>`);
    const select = el.shadowRoot!.querySelector<WaSelect>("wa-select")!;

    select.value = "de";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve));
    await el.updateComplete;

    expect(getLanguage()).to.equal("de");
    expect(document.documentElement.lang).to.equal("de");
    expect(document.title).to.equal("Home Assistant Installationsprogramm");
    expect(el.shadowRoot!.querySelector("wa-button")!.textContent).to.include(
      "Los geht's"
    );
    // Untranslated text stays English
    expect(el.shadowRoot!.querySelector(".learn-more")!.textContent).to.include(
      "Learn more"
    );
  });
});
