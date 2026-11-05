import { expect, test } from "./fixtures.js";

// Forced colors, as in Windows High Contrast, paint backgrounds like the page.
// The numbers of the next steps lost their circles and were left bare, so each
// circle takes the system's highlight, as the chosen drive's check does.

test("forced colors keep the next steps' numbers in their circles", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto("/");
  await page.locator("welcome-view").waitFor({ state: "attached" });
  await page.evaluate(() => {
    document.querySelector("app-shell")!.remove();
    const success = document.createElement("install-success");
    success.steps = ["Power it on", "Open the page", "Log in"];
    document.body.append(success);
  });
  // The system colors as the browser computes them, so they compare as text
  const system = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("span"));
    const resolve = (color: string) => {
      probe.style.color = color;
      return getComputedStyle(probe).color;
    };
    const colors = {
      highlight: resolve("Highlight"),
      highlightText: resolve("HighlightText"),
    };
    probe.remove();
    return colors;
  });

  const numbers = page.locator("install-success .step-item > :first-child");
  await expect(numbers).toHaveCount(3);
  for (const number of await numbers.all()) {
    await expect(number).toBeVisible();
    await expect(number).toHaveCSS("background-color", system.highlight);
    await expect(number).toHaveCSS("color", system.highlightText);
    await expect(number).toHaveCSS("border-top-left-radius", "50%");
  }
  await page.screenshot({
    path: testInfo.outputPath("forced-colors-success.png"),
  });
});
