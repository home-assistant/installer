import { skipWifiStep, test, expect } from "./fixtures.js";

test.describe("Navigation Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("navigates back to welcome from path selection", async ({ page }) => {
    // Navigate to path selection
    await page.getByRole("button", { name: "Let's go" }).click();

    const pathSelectionView = page.locator("path-selection-view");
    await expect(pathSelectionView).toBeVisible();

    // Click back button
    await pathSelectionView.locator("wa-button").click();

    // Should be back on welcome view
    const welcomeView = page.locator("welcome-view");
    await expect(welcomeView).toBeVisible();
    await expect(
      welcomeView.getByRole("button", { name: "Let's go" })
    ).toBeVisible();
  });
});

test.describe("Wizard Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Let's go" }).click();
    await expect(page.locator("path-selection-view")).toBeVisible();
  });

  test("wizard cancel returns to path selection", async ({ page }) => {
    await page
      .locator('option-card[heading="Raspberry Pi & other boards"]')
      .click();

    const wizardShell = page.locator("wizard-shell");
    await expect(wizardShell).toBeVisible();

    // Click cancel
    await wizardShell.locator(".footer-left wa-button").click();

    await expect(page.locator("path-selection-view")).toBeVisible();
    await expect(page.locator("welcome-view")).toHaveCount(0);
  });

  test("wizard back button goes to previous step", async ({ page }) => {
    await page
      .locator('option-card[heading="Raspberry Pi & other boards"]')
      .click();

    const wizardShell = page.locator("wizard-shell");

    // Wait for devices to load; picking one goes on to the second step
    const deviceCard = page.locator("device-card").first();
    await expect(deviceCard).toBeVisible({ timeout: 5000 });
    await deviceCard.click();
    await expect(page.locator("drive-selection-view")).toBeVisible();

    const backButton = wizardShell.locator(".header wa-button");

    // Click back
    await backButton.click();

    // Should be back on first step - device selection view
    await expect(page.locator("device-selection-view")).toBeVisible();
  });
});

test.describe("SBC Confirmation", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to confirmation step
    await page.goto("/");
    await page.getByRole("button", { name: "Let's go" }).click();
    await expect(page.locator("path-selection-view")).toBeVisible();
    await page
      .locator('option-card[heading="Raspberry Pi & other boards"]')
      .click();
    await expect(page.locator("wizard-shell")).toBeVisible();

    // Select a device, which goes on
    const deviceCard = page.locator("device-card").first();
    await expect(deviceCard).toBeVisible({ timeout: 5000 });
    await deviceCard.click();

    // Select a drive and proceed
    await expect(page.locator("drive-selection-view")).toBeVisible();
    const driveCard = page.locator("drive-card").first();
    await expect(driveCard).toBeVisible({ timeout: 5000 });
    await driveCard.click();
    await page
      .locator("wizard-shell")
      .locator(".footer-right wa-button")
      .click();

    // Should now be on confirmation
    await skipWifiStep(page);
  });

  test("Back through Wi-Fi to another drive, which the erase question names", async ({
    page,
  }) => {
    const wizardShell = page.locator("wizard-shell");
    const backButton = wizardShell.locator(".header wa-button");

    // The first board has Wi-Fi, so its step comes before Confirm
    await backButton.click();
    await expect(page.locator("wifi-view")).toBeVisible();
    await backButton.click();
    await expect(page.locator("drive-selection-view")).toBeVisible();
    // The erase warning is left to the erase question
    await expect(page.locator("drive-card").first()).toBeVisible();
    await expect(
      page.locator('drive-selection-view inline-notice[variant="warning"]')
    ).toHaveCount(0);

    // Another drive, which the erase question then names
    const other = page.locator("drive-selection-view drive-card").nth(1);
    const otherName = await other.evaluate(
      (card) => (card as HTMLElement & { name: string }).name
    );
    await other.click();
    await wizardShell.locator(".footer-right wa-button").click();
    await skipWifiStep(page);
    await wizardShell.locator(".footer-right wa-button").click();
    await expect(page.locator("confirm-dialog[open] .drive-name")).toHaveText(
      otherName
    );
  });
});

test.describe("SBC Success", () => {
  let selectedDeviceName: string;

  test.beforeEach(async ({ page }) => {
    // Navigate to success step
    await page.goto("/");
    await page.getByRole("button", { name: "Let's go" }).click();
    await expect(page.locator("path-selection-view")).toBeVisible();
    await page
      .locator('option-card[heading="Raspberry Pi & other boards"]')
      .click();
    await expect(page.locator("wizard-shell")).toBeVisible();

    // Select a device, which goes on
    const deviceCard = page.locator("device-card").first();
    await expect(deviceCard).toBeVisible({ timeout: 5000 });
    selectedDeviceName = await deviceCard.locator(".name").innerText();
    await deviceCard.click();

    // Select a drive and proceed
    await expect(page.locator("drive-selection-view")).toBeVisible();
    const driveCard = page.locator("drive-card").first();
    await expect(driveCard).toBeVisible({ timeout: 5000 });
    await driveCard.click();
    await page
      .locator("wizard-shell")
      .locator(".footer-right wa-button")
      .click();

    // Confirm installation
    await skipWifiStep(page);
    await page
      .locator("wizard-shell")
      .locator(".footer-right wa-button")
      .click();
    const dialog = page.locator("confirm-dialog[open]");
    await expect(dialog).toBeVisible();
    await dialog.locator("wa-button[variant='danger']").click();

    // Wait for flashing to complete (mock takes ~16 seconds total)
    await expect(page.locator("progress-view")).toBeVisible();
    await expect(page.locator("success-view")).toBeVisible({ timeout: 20000 });
  });

  test("names the selected device, and Done returns to path selection", async ({
    page,
  }) => {
    const successView = page.locator("success-view");
    await expect(successView.locator(".step-item").nth(1)).toContainText(
      `Insert the written storage into ${selectedDeviceName}.`
    );

    const wizardShell = page.locator("wizard-shell");
    const doneButton = wizardShell.locator(".footer-right wa-button");
    await doneButton.click();

    await expect(page.locator("path-selection-view")).toBeVisible();
  });
});
