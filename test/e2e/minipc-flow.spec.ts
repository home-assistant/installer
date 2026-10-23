import { test, expect } from "./fixtures.js";

// Mini PC flow order: method → architecture → drive → confirm → flash → success

test.describe("Mini PC Flow - Setup Method Selection", () => {
  test.beforeEach(async ({ page }) => {
    // Use mock mode to avoid real API calls
    await page.goto("/");
    // Navigate to path selection
    await page.getByRole("button", { name: "Let's go" }).click();
    await expect(page.locator("path-selection-view")).toBeVisible();
  });

  test("each media type shows its own steps", async ({ page }) => {
    await page
      .locator('option-card[heading="Mini PC or other computer"]')
      .click();
    await page
      .locator("minipc-setup-method-view")
      .locator("option-card")
      .filter({ hasText: "I need to boot from USB" })
      .click();

    await page
      .locator("minipc-media-view")
      .locator("option-card")
      .filter({ hasText: "ISO file" })
      .click();
    const steps = page.locator("step-indicator");
    await expect(steps).toContainText("Save location");
    await expect(steps).not.toContainText("Select USB stick");

    await page.getByRole("button", { name: "Back", exact: false }).click();
    await page
      .locator("minipc-media-view")
      .locator("option-card")
      .filter({ hasText: "USB stick" })
      .click();
    await expect(steps).toContainText("Select USB stick");
    await expect(steps).not.toContainText("Save location");
  });
});

test.describe("Mini PC Flow - Architecture Selection", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Let's go" }).click();
    await page
      .locator('option-card[heading="Mini PC or other computer"]')
      .click();

    // Select "connect drive" to get to architecture selection
    const setupView = page.locator("minipc-setup-method-view");
    await expect(setupView).toBeVisible();
    const connectDriveOption = setupView
      .locator("option-card, wa-radio")
      .filter({ hasText: "I can connect the drive" });
    await connectDriveOption.click();
  });

  test("after visiting the USB stick path, the architecture must be picked again", async ({
    page,
  }) => {
    const archView = page.locator("minipc-architecture-selection-view");
    await archView
      .locator("option-card, wa-radio")
      .filter({ hasText: "Intel/AMD" })
      .click();
    const back = page.getByRole("button", { name: "Back", exact: false });
    await back.click();

    const setupView = page.locator("minipc-setup-method-view");
    await setupView
      .locator("option-card")
      .filter({ hasText: "I need to boot from USB" })
      .click();
    await page
      .locator("minipc-media-view")
      .locator("option-card")
      .filter({ hasText: "USB stick" })
      .click();
    await expect(page.locator("drive-selection-view")).toBeVisible();
    await back.click();
    await expect(page.locator("minipc-media-view")).toBeVisible();
    await back.click();

    await setupView
      .locator("option-card")
      .filter({ hasText: "I can connect the drive" })
      .click();
    await expect(archView).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Next", exact: true })
    ).toBeDisabled();
  });
});
