import { expect, fixture, html, oneEvent, waitUntil } from "@open-wc/testing";
import type WaSelect from "@home-assistant/webawesome/dist/components/select/select.js";
import "../../../src/views/welcome-view.js";
import type { WelcomeView } from "../../../src/views/welcome-view.js";
import {
  getLanguage,
  setLanguage,
} from "../../../src/localization/localize.js";
import { installerUpdate } from "../../../src/state/installer-update.js";
import { mockTauriIpc, restoreTauriIpc } from "../tauri-ipc.js";

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

  describe("while the installer updates itself", () => {
    // Earlier tests checked for an update through the browser mock
    beforeEach(() => installerUpdate.reset());

    afterEach(() => {
      installerUpdate.reset();
      restoreTauriIpc();
    });

    it("starts no flow once the update installs, as Windows exits during it", async () => {
      let finishInstall!: () => void;
      const navigations: string[] = [];
      mockTauriIpc((cmd) => {
        if (cmd === "check_for_update")
          return {
            version: "2026.12.0",
            release_url:
              "https://github.com/home-assistant/installer/releases/tag/2026.12.0",
            installable: true,
          };
        if (cmd === "install_update")
          return new Promise<void>((resolve) => (finishInstall = resolve));
        if (cmd === "download_update" || cmd === "restart_after_update")
          return undefined;
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });
      const el = await fixture<WelcomeView>(
        html`<welcome-view></welcome-view>`
      );
      el.addEventListener("navigate", (event) =>
        navigations.push((event as CustomEvent).detail.view)
      );
      await installerUpdate.check();
      const letsGo = () =>
        el.shadowRoot!.querySelector<HTMLElement & { disabled: boolean }>(
          "main wa-button"
        )!;

      const updating = installerUpdate.update();
      await waitUntil(() => installerUpdate.state.status === "installing");
      await el.updateComplete;
      expect(letsGo().disabled).to.be.true;
      letsGo().click();

      finishInstall();
      await updating;
      expect(installerUpdate.state.status).to.equal("restarting");
      await el.updateComplete;
      expect(letsGo().disabled).to.be.true;
      letsGo().click();
      expect(navigations).to.deep.equal([]);
    });

    it("still starts a flow while the update downloads", async () => {
      let finishDownload!: () => void;
      mockTauriIpc((cmd) => {
        if (cmd === "check_for_update")
          return {
            version: "2026.12.0",
            release_url:
              "https://github.com/home-assistant/installer/releases/tag/2026.12.0",
            installable: true,
          };
        if (cmd === "download_update")
          return new Promise<void>((resolve) => (finishDownload = resolve));
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });
      const el = await fixture<WelcomeView>(
        html`<welcome-view></welcome-view>`
      );
      await installerUpdate.check();

      void installerUpdate.update();
      await waitUntil(() => installerUpdate.state.status === "downloading");
      await el.updateComplete;
      const button =
        el.shadowRoot!.querySelector<HTMLElement>("main wa-button")!;
      setTimeout(() => button.click());
      const event = await oneEvent(el, "navigate");
      expect((event as CustomEvent).detail.view).to.equal("path-selection");
      finishDownload();
    });
  });
});
