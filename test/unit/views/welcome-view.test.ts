import { expect, fixture, html, oneEvent, waitUntil } from "@open-wc/testing";
import type WaSelect from "@home-assistant/webawesome/dist/components/select/select.js";
import "../../../src/views/welcome-view.js";
import type { WelcomeView } from "../../../src/views/welcome-view.js";
import {
  getLanguage,
  setLanguage,
} from "../../../src/localization/localize.js";
import {
  installerUpdate,
  RESTART_TIMEOUT_MS,
} from "../../../src/state/installer-update.js";
import type { HaAnnouncement } from "../../../src/api/types.js";
import { SCAN_INTERVAL_MS } from "../../../src/utils/home-assistant-scan.js";
import { expectReadsLeftToRight } from "../helpers/bidi.js";
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

  describe("Home Assistant on the network", () => {
    afterEach(() => restoreTauriIpc());

    /** The welcome screen, on a network where `found` answers */
    async function welcome(
      found: HaAnnouncement[],
      onboarded: Record<string, boolean | null> = {}
    ) {
      const opened: string[] = [];
      mockTauriIpc((cmd, args) => {
        switch (cmd) {
          case "find_home_assistants":
            return found;
          case "check_ha_onboarded":
            return onboarded[(args as { ipAddress: string }).ipAddress] ?? null;
          case "plugin:opener|open_url":
            opened.push((args as { url: string }).url);
            return undefined;
          default:
            throw new Error(`Unexpected IPC command: ${cmd}`);
        }
      });
      const el = await fixture<WelcomeView>(
        html`<welcome-view></welcome-view>`
      );
      return { el, opened };
    }

    const instances = (el: WelcomeView) =>
      Array.from(
        el.shadowRoot!.querySelectorAll<HTMLAnchorElement>(".found a")
      );

    it("offers each one to open in the browser, saying which aren't set up yet", async () => {
      const { el, opened } = await welcome(
        [
          {
            id: "home",
            name: "Home",
            address: "192.0.2.20:8123",
            url: "http://192.0.2.20:8123/",
            landing_page: false,
          },
          {
            id: "cabin",
            name: "Cabin",
            address: "192.0.2.30:8123",
            // Its internal_url, by name and over HTTPS
            url: "https://cabin.example:8123/",
            landing_page: false,
          },
          {
            id: "new",
            name: null,
            address: "192.0.2.50",
            url: "http://192.0.2.50/",
            landing_page: true,
          },
        ],
        { "192.0.2.20:8123": true, "192.0.2.30:8123": false }
      );
      await waitUntil(() => instances(el).length === 3);

      const section = el.shadowRoot!.querySelector("main .found")!;
      expect(section.querySelector("h2")!.textContent!.trim()).to.equal(
        "Home Assistant on your network"
      );
      expect(section.getAttribute("aria-labelledby")).to.equal(
        section.querySelector("h2")!.id
      );
      const links = instances(el);
      expect(links.map((link) => link.getAttribute("href"))).to.deep.equal([
        "https://cabin.example:8123/",
        "http://192.0.2.20:8123/",
        "http://192.0.2.50/",
      ]);
      // Each says where it opens, what it is ready for, and that it leaves
      // the installer
      expect(
        links.map((link) => link.textContent!.replace(/\s+/g, " ").trim())
      ).to.deep.equal([
        "Cabin cabin.example:8123 Not set up yet Opens in your browser.",
        "Home 192.0.2.20:8123 Opens in your browser.",
        "Home Assistant 192.0.2.50 Installing Opens in your browser.",
      ]);
      for (const link of links) {
        expect(link.target).to.equal("_blank");
        expect(link.rel).to.equal("noopener noreferrer");
      }

      links[0].click();
      await waitUntil(() => opened.length === 1);
      expect(opened).to.deep.equal(["https://cabin.example:8123/"]);
    });

    it("lays them out in one row that scrolls", async () => {
      const { el } = await welcome(
        ["A", "B", "C", "D", "E", "F", "G"].map((name, index) => ({
          id: name,
          name,
          address: `192.0.2.${index + 1}:8123`,
          url: `http://192.0.2.${index + 1}:8123/`,
          landing_page: false,
        })),
        {}
      );
      await waitUntil(() => instances(el).length === 7);

      const tops = instances(el).map(
        (link) => link.getBoundingClientRect().top
      );
      expect(new Set(tops).size).to.equal(1);
      expect(el.shadowRoot!.querySelector(".found scroll-row ul")).to.exist;
    });

    it("keeps the card that has the focus as another comes before it", async () => {
      const setTimeout = window.setTimeout;
      // The wait before the next lookup, which the test ends
      let lookAgain: (() => void) | undefined;
      window.setTimeout = ((
        handler: () => void,
        timeout?: number,
        ...args: unknown[]
      ) => {
        if (timeout !== SCAN_INTERVAL_MS)
          return setTimeout(handler, timeout, ...args);
        lookAgain = handler;
        return 0;
      }) as typeof window.setTimeout;
      const homeAssistant = (name: string, address: string) => ({
        id: name,
        name,
        address,
        url: `http://${address}/`,
        landing_page: false,
      });
      try {
        const found = [homeAssistant("Home", "192.0.2.20:8123")];
        const { el } = await welcome(found);
        await waitUntil(() => instances(el).length === 1 && lookAgain);
        const home = instances(el)[0];
        home.focus();

        // The next lookup finds one that goes before it
        found.push(homeAssistant("Cabin", "192.0.2.30:8123"));
        lookAgain!();
        await waitUntil(() => instances(el).length === 2);

        expect(instances(el)[1]).to.equal(home);
        expect(el.shadowRoot!.activeElement).to.equal(home);
        expect(home.getAttribute("href")).to.equal("http://192.0.2.20:8123/");
      } finally {
        window.setTimeout = setTimeout;
      }
    });

    it("keeps a long name it is opened at within its card", async () => {
      const { el } = await welcome([
        {
          id: "long",
          name: "Home",
          address: "192.0.2.20:8123",
          url: "https://homeassistantwithalonghostname.example:8123/",
          landing_page: false,
        },
      ]);
      await waitUntil(() => instances(el).length === 1);

      const card = instances(el)[0];
      const address = card
        .querySelector(".instance-address")!
        .getBoundingClientRect();
      // Clear of the icon that says it opens in the browser
      expect(address.right).to.be.at.most(
        card.querySelector(".instance-open")!.getBoundingClientRect().left
      );
      expect(card.scrollWidth).to.equal(card.clientWidth);
    });

    it("keeps each name its own direction, and each address left to right", async () => {
      document.documentElement.dir = "rtl";
      try {
        const { el } = await welcome([
          {
            id: "home",
            name: "Home",
            address: "192.0.2.20:8123",
            url: "http://192.0.2.20:8123/",
            landing_page: false,
          },
        ]);
        await waitUntil(() => instances(el).length === 1);

        expect(
          el
            .shadowRoot!.querySelector(".instance-name bdi")!
            .hasAttribute("dir")
        ).to.be.false;
        expectReadsLeftToRight(
          el.shadowRoot!.querySelector(".instance-address")!
        );
      } finally {
        document.documentElement.dir = "";
      }
    });

    it("shows nothing while no Home Assistant answers", async () => {
      const { el } = await welcome([]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector(".found")).to.be.null;
    });
  });

  describe("while the installer updates itself", () => {
    // Earlier tests checked for an update through the browser mock
    beforeEach(() => installerUpdate.reset());

    const setTimeout = window.setTimeout;

    afterEach(() => {
      window.setTimeout = setTimeout;
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
      // Holds back only the restart's timeout; waitUntil needs the others
      let finishRestartTimeout!: () => void;
      window.setTimeout = ((
        handler: () => void,
        timeout?: number,
        ...args: unknown[]
      ) => {
        if (timeout !== RESTART_TIMEOUT_MS)
          return setTimeout(handler, timeout, ...args);
        finishRestartTimeout = handler;
        return 0;
      }) as typeof window.setTimeout;

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

      // Still there after a while: the backend starts no installation until
      // the app exits, so neither does Let's go
      finishRestartTimeout();
      expect(installerUpdate.state.status).to.equal("ready");
      await el.updateComplete;
      expect(letsGo().disabled).to.be.true;
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
