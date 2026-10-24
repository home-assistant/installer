import {
  expect,
  fixture,
  fixtureSync,
  html,
  waitUntil,
} from "@open-wc/testing";
import { emulateMedia } from "@web/test-runner-commands";
import "../../../src/components/install-success.js";
import type { InstallSuccess } from "../../../src/components/install-success.js";
import {
  findByRole,
  fullA11ySnapshot,
  headingOutline,
} from "../helpers/a11y.js";
import { contrast } from "../helpers/contrast.js";
import { expectThemeLink } from "../helpers/link-style.js";

const USER_AGENTS = {
  macOS:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  Windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)",
  Linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)",
};

function setUserAgent(platform: keyof typeof USER_AGENTS) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: USER_AGENTS[platform],
    configurable: true,
  });
}

describe("install-success", () => {
  // The stub shadows the prototype getter; deleting it restores the real UA.
  afterEach(async () => {
    delete (window.navigator as { userAgent?: string }).userAgent;
    await emulateMedia({ colorScheme: "light" });
  });

  it("puts Casita beside the next steps under the heading when wide, and above it when narrow", async () => {
    const container = fixtureSync<HTMLDivElement>(html`
      <div style="width: 736px">
        <install-success
          .subtitle=${"Installed on the fixture."}
          .steps=${["Power it on", "Log in"]}
        ></install-success>
      </div>
    `);
    const el = container.querySelector("install-success")!;
    await el.updateComplete;
    const bounds = (selector: string) =>
      el.shadowRoot!.querySelector(selector)!.getBoundingClientRect();

    // The smallest window leaves 736px: the next steps fit beside Casita,
    // and the heading spans both
    expect(bounds(".mascot-container").right).to.be.at.most(
      bounds(".details").left
    );
    expect(bounds(".heading").bottom).to.be.at.most(
      bounds(".mascot-container").top
    );
    expect(bounds(".heading").bottom).to.be.at.most(bounds(".details").top);
    expect(bounds(".mascot-container").width).to.equal(140);
    expect(bounds(".details").right).to.be.at.most(
      container.getBoundingClientRect().right
    );

    container.style.width = "500px";
    await waitUntil(
      () => bounds(".mascot-container").bottom <= bounds("h2").top,
      "Casita should stand above the heading"
    );
  });

  it("numbers the next steps in a labelled list", async () => {
    const el = await fixture<InstallSuccess>(
      html`<install-success
        .subtitle=${"Installed on the fixture."}
        .steps=${["Power it on", html`Open <a href="#">the page</a>`, "Log in"]}
      ></install-success>`
    );
    expect(el.shadowRoot!.querySelector("h2")!.textContent).to.equal(
      "You're all set!"
    );
    expect(el.shadowRoot!.querySelector(".subtitle")!.textContent).to.equal(
      "Installed on the fixture."
    );
    const list = el.shadowRoot!.querySelector("ol")!;
    expect(list.getAttribute("aria-label")).to.equal("Next steps");
    const steps = [...list.querySelectorAll("li")];
    expect(
      steps.map((step) => step.querySelector(".badge")!.textContent)
    ).to.deep.equal(["1", "2", "3"]);
    expect(
      steps.map((step) =>
        step.querySelector(".step-text")!.textContent!.replace(/\s+/g, " ")
      )
    ).to.deep.equal(["Power it on", "Open the page", "Log in"]);
    expect(steps[1].querySelector("a")).to.exist;

    const lists = findByRole(await fullA11ySnapshot(), "list");
    expect(lists.map((node) => node.name)).to.include("Next steps");
  });

  it("heads the next steps and the companion app under the step's heading", async () => {
    await fixture<InstallSuccess>(
      html`<install-success
        .subtitle=${"Installed on the fixture."}
        .steps=${["Power it on"]}
      ></install-success>`
    );

    // Chrome names the next steps' heading as it shows it, in capitals
    expect(headingOutline(await fullA11ySnapshot())).to.deep.equal([
      [2, "You're all set!"],
      [3, "NEXT STEPS"],
      [3, "Get the Home Assistant Companion App"],
    ]);
  });

  it("leaves out the notice, footer and tip unless given", async () => {
    setUserAgent("Windows");
    const el = await fixture<InstallSuccess>(
      html`<install-success .steps=${["Only step"]}></install-success>`
    );
    expect(el.shadowRoot!.querySelector(".next-steps-footer")).to.not.exist;
    expect(el.shadowRoot!.querySelector(".tip-section")).to.not.exist;

    el.formatWarning = true;
    el.footer = html`<a href="#">Full guide</a>`;
    el.tip = "Manage it from the dashboard.";
    await el.updateComplete;
    // The notice comes before the steps, the footer after them
    const text = el.shadowRoot!.querySelector(".next-steps")!.textContent!;
    expect(text.indexOf("Choose Cancel.")).to.be.within(
      0,
      text.indexOf("Only step")
    );
    expect(text.indexOf("Full guide")).to.be.greaterThan(
      text.indexOf("Only step")
    );
    expect(el.shadowRoot!.querySelector(".tip-section")!.textContent).to.equal(
      "Manage it from the dashboard."
    );
  });

  for (const [platform, wording] of [
    ["macOS", "macOS may say it can't read this disk"],
    ["Windows", "Windows may offer to format this drive"],
    ["Linux", undefined],
  ] as const) {
    it(`${wording ? "words" : "leaves out"} the format warning for ${platform}`, async () => {
      setUserAgent(platform);
      const el = await fixture<InstallSuccess>(
        html`<install-success .formatWarning=${true}></install-success>`
      );
      const notice = el.shadowRoot!.querySelector("inline-notice")?.textContent;
      if (wording) expect(notice).to.contain(wording);
      else expect(notice).to.equal(undefined);
    });
  }

  it("leaves as much room under the format warning as above it", async () => {
    setUserAgent("Windows");
    const el = await fixture<InstallSuccess>(
      html`<install-success
        .formatWarning=${true}
        .steps=${["Only step"]}
      ></install-success>`
    );
    const bounds = (selector: string) =>
      el.shadowRoot!.querySelector(selector)!.getBoundingClientRect();

    const above =
      bounds("inline-notice").top - bounds(".next-steps-title").bottom;
    expect(above).to.be.greaterThan(0);
    expect(
      bounds(".steps-list").top - bounds("inline-notice").bottom
    ).to.be.closeTo(above, 0.5);
  });

  it("underlines links in the steps and footer, not the app buttons", async () => {
    const el = await fixture<InstallSuccess>(
      html`<install-success
        .steps=${[
          html`Open <a href="#">homeassistant.local</a> in your browser`,
        ]}
        .footer=${html`<a href="#">Full guide</a>`}
      ></install-success>`
    );
    expectThemeLink(el.shadowRoot!.querySelector(".step-text a")!);
    expectThemeLink(el.shadowRoot!.querySelector(".next-steps-footer a")!);
    // Bordered, with an icon: buttons more than links in a sentence
    for (const link of el.shadowRoot!.querySelectorAll(".app-link"))
      expect(getComputedStyle(link).textDecorationLine).to.equal("none");
  });

  it("shows slotted content and keeps Casita decorative", async () => {
    const el = await fixture<InstallSuccess>(
      html`<install-success><p id="extra">Reminder</p></install-success>`
    );
    const slot = el.shadowRoot!.querySelector("slot")!;
    expect(slot.assignedElements().map((element) => element.id)).to.deep.equal([
      "extra",
    ]);
    const mascot = el.shadowRoot!.querySelector(".mascot-container")!;
    expect(mascot.getAttribute("aria-hidden")).to.equal("true");
    expect(
      mascot.querySelector("casita-mascot")!.getAttribute("mood")
    ).to.equal("happy");
  });

  it("links both companion app stores", async () => {
    const el = await fixture<InstallSuccess>(
      html`<install-success></install-success>`
    );
    const links = [
      ...el.shadowRoot!.querySelectorAll<HTMLAnchorElement>(".app-link"),
    ];
    expect(links.map((link) => link.textContent!.trim())).to.deep.equal([
      "App Store Opens in your browser.",
      "Google Play Opens in your browser.",
    ]);
    for (const link of links) {
      expect(link.target).to.equal("_blank");
      expect(link.rel).to.equal("noopener noreferrer");
    }
  });

  it("draws the step numbers as the badge the drive cards use", async () => {
    const el = await fixture<InstallSuccess>(
      html`<install-success .steps=${["Power it on"]}></install-success>`
    );
    const badge = getComputedStyle(el.shadowRoot!.querySelector(".badge")!);
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = "var(--ha-primary-fill)";
    const fill = getComputedStyle(probe).color;
    probe.remove();

    expect(badge.width).to.equal("24px");
    expect(badge.height).to.equal("24px");
    expect(badge.backgroundColor).to.equal(fill);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    it(`tints the tip with the theme's color, readably, in ${colorScheme} mode`, async () => {
      await emulateMedia({ colorScheme });
      const el = await fixture<InstallSuccess>(
        html`<install-success
          .tip=${html`<strong>Tip:</strong> You can manage it anytime.`}
        ></install-success>`
      );
      const tip = el.shadowRoot!.querySelector(".tip-section")!;
      const probe = document.body.appendChild(document.createElement("span"));
      probe.style.backgroundColor = "var(--wa-color-brand-fill-quiet)";
      const tint = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const background = getComputedStyle(tip).backgroundColor;
      const page = getComputedStyle(document.documentElement).backgroundColor;

      // Not the old Home Assistant blue, which the theme left behind
      expect(background).to.equal(tint);
      expect(
        contrast(getComputedStyle(tip).color, background, page)
      ).to.be.at.least(4.5);
      expect(
        contrast(
          getComputedStyle(tip.querySelector("strong")!).color,
          background,
          page
        )
      ).to.be.at.least(4.5);
    });
  }
});
