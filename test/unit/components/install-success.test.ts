import { expect, fixture, html } from "@open-wc/testing";
import "../../../src/components/install-success.js";
import type { InstallSuccess } from "../../../src/components/install-success.js";
import { findByRole, fullA11ySnapshot } from "../helpers/a11y.js";
import { expectThemeLink } from "../helpers/link-style.js";

describe("install-success", () => {
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
      steps.map((step) => step.querySelector(".step-number")!.textContent)
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

  it("leaves out the footer and tip unless given", async () => {
    const el = await fixture<InstallSuccess>(
      html`<install-success .steps=${["Only step"]}></install-success>`
    );
    expect(el.shadowRoot!.querySelector(".next-steps-footer")).to.not.exist;
    expect(el.shadowRoot!.querySelector(".tip-section")).to.not.exist;

    el.footer = html`<a href="#">Full guide</a>`;
    el.tip = "Manage it from the dashboard.";
    await el.updateComplete;
    // The footer comes after the steps
    const text = el.shadowRoot!.querySelector(".next-steps")!.textContent!;
    expect(text.indexOf("Full guide")).to.be.greaterThan(
      text.indexOf("Only step")
    );
    expect(el.shadowRoot!.querySelector(".tip-section")!.textContent).to.equal(
      "Manage it from the dashboard."
    );
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
      "App Store",
      "Google Play",
    ]);
    for (const link of links) {
      expect(link.target).to.equal("_blank");
      expect(link.rel).to.equal("noopener noreferrer");
    }
  });
});
