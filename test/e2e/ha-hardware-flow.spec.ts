import { test, expect } from "@playwright/test";

test("hides the unfinished Home Assistant hardware flow", async ({ page }) => {
  await page.goto("/");
  await page.locator("welcome-view").locator("wa-button").click();

  const pathSelection = page.locator("path-selection-view");
  await expect(pathSelection).toBeVisible();
  await expect(
    pathSelection.locator('option-card[icon="ha-hardware"]')
  ).toHaveCount(0);

  await pathSelection
    .locator('option-card[title="Raspberry Pi & other boards"]')
    .click();
  await expect(page.locator("device-selection-view")).toBeVisible();
});
