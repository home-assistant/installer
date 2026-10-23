import { expect, test } from "./fixtures.js";

// The smallest window, 800 by 750, zoomed to 200% is 400 by 375. There, as in
// a regular window, the current step keeps its name beside its dot, wrapped
// if it must be, without making the header taller than Back does.
for (const [width, height] of [
  [400, 375],
  [800, 720],
] as const) {
  test(`the steps name the current one at ${width} by ${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.getByRole("button", { name: "Let's go" }).click();
    await page
      .locator('option-card[heading="Mini PC or other computer"]')
      .click();

    const header = page.locator("wizard-shell .header:has(step-indicator)");
    const indicator = header.locator("step-indicator");
    const current = indicator.locator(".step-label.active");
    await expect(current).toHaveText("Installation method");
    const name = (await current.boundingBox())!;
    const room = (await indicator.boundingBox())!;
    expect(name.width).toBeGreaterThan(1);
    expect(name.x).toBeGreaterThanOrEqual(room.x);
    expect(name.x + name.width).toBeLessThanOrEqual(room.x + room.width);
    const back = (await header.locator("> wa-button").boundingBox())!;
    expect(name.height).toBeLessThanOrEqual(back.height);
  });
}
