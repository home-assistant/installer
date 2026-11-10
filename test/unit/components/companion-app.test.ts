import { expect, fixture, html } from "@open-wc/testing";
import "../../../src/components/companion-app.js";
import type { CompanionApp } from "../../../src/components/companion-app.js";
import { captureOpenedUrls, restoreTauriIpc, settle } from "../tauri-ipc.js";

describe("companion-app", () => {
  afterEach(() => {
    restoreTauriIpc();
  });

  it("shows one code, for the page that opens the phone's own store", async () => {
    const el = await fixture<CompanionApp>(
      html`<companion-app></companion-app>`
    );
    const codes = el.shadowRoot!.querySelectorAll("wa-qr-code");
    expect(codes).to.have.length(1);
    const [code] = codes;
    expect(code.value).to.equal("https://my.home-assistant.io/app/");
    await code.updateComplete;
    // Named for what it does, not read out as an address
    const canvas = code.shadowRoot!.querySelector("canvas")!;
    expect(canvas.getAttribute("role")).to.equal("img");
    expect(canvas.getAttribute("aria-label")).to.equal(
      "QR code that opens the Home Assistant Companion App in your phone's app store"
    );
    // Drawn, at the size it is shown
    expect(canvas.width).to.be.greaterThan(0);
    expect(code.getBoundingClientRect().width).to.equal(120);
  });

  it("draws the code dark on white whatever the theme", async () => {
    const el = await fixture<CompanionApp>(
      html`<companion-app style="color: white"></companion-app>`
    );
    const style = getComputedStyle(el.shadowRoot!.querySelector("wa-qr-code")!);
    expect(style.color).to.equal("rgb(0, 0, 0)");
    expect(style.backgroundColor).to.equal("rgb(255, 255, 255)");
    // The quiet zone a scanner needs around the code
    expect(style.paddingTop).to.equal("8px");
  });

  it("links both stores for this computer, under one heading", async () => {
    const opened = captureOpenedUrls();
    const el = await fixture<CompanionApp>(
      html`<companion-app></companion-app>`
    );
    expect(el.shadowRoot!.querySelector("h3")!.textContent).to.equal(
      "Get the Home Assistant Companion App"
    );
    expect(el.shadowRoot!.querySelector(".scan")!.textContent).to.equal(
      "Scan the code with your phone's camera, or open a store:"
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
      // Bordered, with an icon: buttons more than links in a sentence
      expect(getComputedStyle(link).textDecorationLine).to.equal("none");
      link.click();
    }
    await settle();
    expect(opened).to.deep.equal([
      "https://apps.apple.com/app/home-assistant/id1099568401",
      "https://play.google.com/store/apps/details?id=io.homeassistant.companion.android",
    ]);
  });

  it("keeps the code and the stores inside a narrow column", async () => {
    const el = await fixture<CompanionApp>(
      html`<companion-app style="width: 280px"></companion-app>`
    );
    const box = el.getBoundingClientRect();
    for (const part of el.shadowRoot!.querySelectorAll(
      "wa-qr-code, .app-link"
    )) {
      const bounds = part.getBoundingClientRect();
      expect(bounds.left).to.be.at.least(box.left);
      expect(bounds.right).to.be.at.most(box.right);
    }
  });
});
