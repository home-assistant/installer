import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import type WaButton from "@home-assistant/webawesome/dist/components/button/button.js";
import type WaRadioGroup from "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import "../../../src/components/accessibility-menu.js";
import type { AccessibilityMenu } from "../../../src/components/accessibility-menu.js";
import { setTextSize, textSize } from "../../../src/utils/text-size.js";
import { setTheme, theme } from "../../../src/utils/theme.js";

async function renderMenu() {
  const menu = await fixture<AccessibilityMenu>(
    html`<accessibility-menu></accessibility-menu>`
  );
  const root = menu.shadowRoot!;
  return {
    menu,
    themes: root.querySelector<WaRadioGroup>("wa-radio-group")!,
    smaller: root.querySelector<WaButton>(".smaller")!,
    larger: root.querySelector<WaButton>(".larger")!,
    size: () => root.querySelector(".stepper span")!.textContent,
  };
}

describe("accessibility-menu", () => {
  afterEach(() => {
    setTextSize(1);
    setTheme("system");
    localStorage.removeItem("hai:text-size");
    localStorage.removeItem("hai:theme");
  });

  it("opens from a button named Accessibility", async () => {
    const { menu } = await renderMenu();

    expect(menu.shadowRoot!.querySelector("header-menu")!.label).to.equal(
      "Accessibility"
    );
  });

  it("offers the themes, at the current one", async () => {
    const { themes } = await renderMenu();

    expect(themes.label).to.equal("Theme");
    expect(themes.value).to.equal("system");
    expect(
      Array.from(themes.querySelectorAll("wa-radio"), (radio) =>
        radio.textContent!.trim()
      )
    ).to.deep.equal(["Match system", "Light", "Dark"]);
  });

  it("shows the theme chosen", async () => {
    const { themes } = await renderMenu();

    themes.value = "dark";
    themes.dispatchEvent(new Event("change", { bubbles: true }));

    expect(theme()).to.equal("dark");
    expect(document.documentElement.classList.contains("wa-dark")).to.be.true;
  });

  it("shows the text size between smaller and larger", async () => {
    const { smaller, larger, size } = await renderMenu();

    expect(size()).to.equal("100%");
    expect(smaller.accessibleLabel).to.equal("Smaller text");
    expect(larger.accessibleLabel).to.equal("Larger text");
    expect(smaller.disabled).to.be.true;
    expect(larger.disabled).to.be.false;
  });

  it("steps through the sizes", async () => {
    const { menu, smaller, larger, size } = await renderMenu();

    larger.click();
    await menu.updateComplete;
    expect(textSize()).to.equal(1.25);
    expect(size()).to.equal("125%");
    expect(smaller.disabled).to.be.false;

    smaller.click();
    await menu.updateComplete;
    expect(textSize()).to.equal(1);
  });

  it("keeps the focus in the panel at the end of the range", async () => {
    setTextSize(1.75);
    const { menu, smaller, larger } = await renderMenu();
    // Only the open panel's buttons take the focus
    menu
      .shadowRoot!.querySelector("header-menu")!
      .shadowRoot!.querySelector("button")!
      .click();

    larger.focus();
    larger.click();

    await waitUntil(() => menu.shadowRoot!.activeElement === smaller);
    expect(textSize()).to.equal(2);
    expect(larger.disabled).to.be.true;
  });

  it("follows the size the zoom keys choose", async () => {
    const { menu, size } = await renderMenu();

    setTextSize(1.5);
    await menu.updateComplete;

    expect(size()).to.equal("150%");
  });
});
