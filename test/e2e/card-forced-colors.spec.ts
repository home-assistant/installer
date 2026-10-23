import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

// Forced colors, as in Windows High Contrast, give every card border the same
// color and paint backgrounds like the page, so the drive cards mark the
// chosen one with system colors. The focus ring stays apart from it.

// Tab into the cards rather than clicking them, so the focus ring shows
async function tabTo(page: Page, card: Locator) {
  await expect(card).toBeVisible();
  for (let count = 0; count < 40; count++) {
    if (await card.evaluate((el) => el.matches(":focus"))) return;
    await page.keyboard.press("Tab");
  }
  await expect(card).toBeFocused();
}

/** The system colors as the browser computes them, so they compare as text. */
function systemColors(page: Page) {
  return page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("span"));
    const resolve = (color: string) => {
      probe.style.color = color;
      return getComputedStyle(probe).color;
    };
    const colors = {
      canvasText: resolve("CanvasText"),
      grayText: resolve("GrayText"),
      highlight: resolve("Highlight"),
      highlightText: resolve("HighlightText"),
    };
    probe.remove();
    return colors;
  });
}

type SystemColors = Awaited<ReturnType<typeof systemColors>>;

async function expectChosen(
  chosen: Locator,
  other: Locator,
  system: SystemColors
) {
  await expect(chosen).toHaveJSProperty("checked", true);
  await expect(chosen.locator(".card")).toHaveCSS(
    "border-top-color",
    system.highlight
  );
  await expect(other.locator(".card")).not.toHaveCSS(
    "border-top-color",
    system.highlight
  );
  const check = chosen.locator(".selected-indicator");
  await expect(check).toBeVisible();
  await expect(check).toHaveCSS("background-color", system.highlight);
  await expect(check).toHaveCSS("color", system.highlightText);
  await expect(other.locator(".selected-indicator")).toHaveCount(0);
}

// The ring sits outside the border, in a color of its own, so a focused card
// stays apart from the chosen one. Chromium forces it to the text color;
// WebKit only matches the media query and keeps the theme's colors.
async function expectFocusRing(card: Locator, system: SystemColors) {
  const ring = card.locator(".card");
  await expect(ring).toHaveCSS("outline-style", "solid");
  await expect(ring).not.toHaveCSS("outline-width", "0px");
  await expect(ring).not.toHaveCSS("outline-color", system.highlight);
}

test("forced colors keep the focused device and the chosen drive apart", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto("/?mock=true");
  await page.evaluate(async () => {
    const path = "/src/api/mock-data.ts";
    const { MOCK_BLOCK_DEVICES } = (await import(
      path
    )) as typeof import("../../src/api/mock-data.js");
    const original = MOCK_BLOCK_DEVICES[0];
    MOCK_BLOCK_DEVICES.splice(
      0,
      MOCK_BLOCK_DEVICES.length,
      { ...original, id: "/dev/first", name: "First drive" },
      { ...original, id: "/dev/second", name: "Second drive" },
      {
        ...original,
        id: "/dev/small",
        name: "Small drive",
        size: 8_000_000_000,
      }
    );
  });
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .locator('option-card[heading="Raspberry Pi & other boards"]')
    .click();
  const system = await systemColors(page);

  // Picking a device goes on, so none is chosen
  const devices = page.locator("device-selection-view device-card");
  await tabTo(page, devices.nth(1));
  await expectFocusRing(devices.nth(1), system);
  await page.screenshot({
    path: testInfo.outputPath("forced-colors-device.png"),
  });

  await page.keyboard.press("Enter");
  const drives = page.locator("drive-selection-view drive-card");
  const first = drives.filter({ hasText: "First drive" });
  const second = drives.filter({ hasText: "Second drive" });
  await tabTo(page, first);
  await page.keyboard.press("ArrowDown");
  await expectChosen(second, first, system);
  await expectFocusRing(second, system);

  // A drive that can't be picked is drawn in the disabled text color, at
  // full strength so its reason stays readable
  const small = drives.filter({ hasText: "Small drive" });
  await expect(small).toHaveJSProperty("disabled", true);
  for (const part of [".card", ".icon-container", ".name", ".size"]) {
    await expect(small.locator(part)).toHaveCSS("opacity", "1");
  }
  await expect(small.locator(".card")).toHaveCSS(
    "border-top-color",
    system.grayText
  );
  for (const part of [".name", ".details", ".size"]) {
    await expect(small.locator(part)).toHaveCSS("color", system.grayText);
  }
  await expect(small.locator(".icon-container svg")).toHaveCSS(
    "fill",
    system.grayText
  );
  await expect(first.locator(".name")).not.toHaveCSS("color", system.grayText);
  await page.screenshot({
    path: testInfo.outputPath("forced-colors-drive.png"),
  });
});
