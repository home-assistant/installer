import { expect, fixtureSync, html } from "@open-wc/testing";
import { mockWindows } from "@tauri-apps/api/mocks";
import "../../../src/components/header-menu.js";
import type { HeaderMenu } from "../../../src/components/header-menu.js";
import { setTextSize } from "../../../src/utils/text-size.js";
import { mockTauriIpc, restoreTauriIpc } from "../tauri-ipc.js";

async function renderMenu() {
  // fixtureSync + updateComplete rather than fixture(): a plain div root
  // makes fixture() wait for an animation frame, which never comes while the
  // test page is backgrounded.
  const header = fixtureSync<HTMLElement>(
    html`<div style="display: flex; justify-content: flex-end; padding: 1rem">
      <header-menu label="Accessibility"><p>Inside</p></header-menu>
    </div>`
  );
  const menu = header.querySelector<HeaderMenu>("header-menu")!;
  await menu.updateComplete;
  const button = menu.shadowRoot!.querySelector("button")!;
  const panel = menu.shadowRoot!.querySelector<HTMLElement>("[popover]")!;
  const body = panel.querySelector<HTMLElement>(".body")!;
  return { menu, button, panel, body };
}

describe("header-menu", () => {
  afterEach(() => {
    restoreTauriIpc();
    setTextSize(1);
    localStorage.removeItem("hai:text-size");
  });

  it("names its button and the panel it opens", async () => {
    const { button, panel } = await renderMenu();

    expect(button.title).to.equal("Accessibility");
    expect(panel.getAttribute("role")).to.equal("dialog");
    expect(panel.getAttribute("aria-label")).to.equal("Accessibility");
    expect(panel.matches(":popover-open")).to.be.false;
  });

  it("opens its panel below the button, lined up with its end", async () => {
    const { menu, button, panel } = await renderMenu();

    button.click();
    await menu.updateComplete;

    expect(panel.matches(":popover-open")).to.be.true;
    const below = button.getBoundingClientRect();
    const place = panel.getBoundingClientRect();
    expect(place.top).to.be.closeTo(below.bottom + 4, 1);
    expect(place.right).to.be.closeTo(below.right, 1);
  });

  it("keeps the open panel in place on screen while the window zooms", async () => {
    mockTauriIpc(() => undefined);
    mockWindows("main");
    const { menu, button, panel, body } = await renderMenu();
    button.click();
    await menu.updateComplete;
    const top = parseFloat(panel.style.top);

    setTextSize(2);
    window.dispatchEvent(new Event("resize"));
    await menu.updateComplete;

    // Half the CSS pixels at twice the zoom is the same place and size
    expect(parseFloat(panel.style.top)).to.equal(top / 2);
    expect(body.style.zoom).to.equal("0.5");

    // Opens at the window's size next time
    button.click();
    button.click();
    await menu.updateComplete;
    expect(body.style.zoom).to.equal("1");
  });
});
