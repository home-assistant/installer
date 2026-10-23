import { test, expect } from "./fixtures.js";

test.describe("Other Options View", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Navigate to path selection
    await page.getByRole("button", { name: "Let's go" }).click();
    await expect(page.locator("path-selection-view")).toBeVisible();
  });

  test("fits a short window and scrolls to the last option", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.locator('option-card[heading="Other options"]').click();

    const view = page.locator("other-options-view");
    const box = await view.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(600);

    const lastOption = view.locator("option-card").last();
    await lastOption.scrollIntoViewIfNeeded();
    await expect(lastOption).toBeInViewport();
  });

  test("has back button that returns to path selection", async ({ page }) => {
    await page.locator('option-card[heading="Other options"]').click();

    const otherOptionsView = page.locator("other-options-view");
    await expect(otherOptionsView).toBeVisible();

    // Click back button
    const backButton = otherOptionsView.locator("wa-button");
    await expect(backButton).toBeVisible();
    await backButton.click();

    // Should be back on path selection
    await expect(page.locator("path-selection-view")).toBeVisible();
  });
});
