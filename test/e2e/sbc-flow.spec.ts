import { test, expect } from "@playwright/test";

// SBC flow order: device → drive → confirm → flash → success
// Browser-only mode serves the mock block devices, so the drive list is the
// three entries in src/api/mock-data.ts.

const nextButton = (page: import("@playwright/test").Page) =>
  page.locator("wizard-shell").locator(".footer-right wa-button");

async function openDriveSelection(page: import("@playwright/test").Page) {
  await page.goto("/?mock=true");
  await page.locator("welcome-view").locator("wa-button").click();
  await page
    .locator('option-card[title="Raspberry Pi & other boards"]')
    .click();

  const deviceView = page.locator("device-selection-view");
  await expect(deviceView).toBeVisible();
  await deviceView.locator("device-card").first().click();
  await nextButton(page).click();

  const driveView = page.locator("drive-selection-view");
  await expect(driveView).toBeVisible();
  await expect(driveView.locator("drive-card").first()).toBeVisible();
  return driveView;
}

async function openConfirmation(page: import("@playwright/test").Page) {
  const driveView = await openDriveSelection(page);
  await driveView.locator("drive-card").first().click();
  await nextButton(page).click();

  const confirmView = page.locator("confirmation-view");
  await expect(confirmView).toBeVisible();
  return confirmView;
}

test.describe("SBC Flow - Drive Selection", () => {
  // Every scan re-checks the stored selection against the devices actually
  // present. A drive that is still there must survive that check.
  test("keeps the selection across a refresh while the drive is connected", async ({
    page,
  }) => {
    const driveView = await openDriveSelection(page);
    const card = driveView.locator("drive-card").first();
    await card.click();
    await expect(nextButton(page)).toHaveJSProperty("disabled", false);

    await driveView.locator(".drives-header wa-button").click();

    await expect(card.locator(".card.selected")).toBeVisible();
    await expect(nextButton(page)).toHaveJSProperty("disabled", false);
    await expect(driveView.locator(".notice")).toBeHidden();
  });
});

test.describe("SBC Flow - Confirmation", () => {
  test("summary names the device that will be written to", async ({ page }) => {
    const confirmView = await openConfirmation(page);

    // The path is what the backend receives; without it two identical cards
    // are indistinguishable.
    await expect(confirmView.locator(".drive-path")).toContainText(
      "mock-usb-drive-128gb"
    );
    await expect(confirmView).toContainText("USB Drive 128GB");
    await expect(confirmView).toContainText("Kingston USB Flash Drive");
  });

  test("Install opens the erase confirmation", async ({ page }) => {
    await openConfirmation(page);

    await nextButton(page).click();

    const dialog = page.locator("confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Erase drive and install?");
  });

  test("erase confirmation shows the exact device being erased", async ({
    page,
  }) => {
    await openConfirmation(page);
    await nextButton(page).click();

    const dialog = page.locator("confirm-dialog");
    await expect(dialog.locator(".detail-value.path")).toHaveText(
      "mock-usb-drive-128gb"
    );
    await expect(dialog.locator(".drive-details")).toContainText(
      "Kingston USB Flash Drive"
    );
    await expect(dialog.locator(".drive-details")).toContainText("128 GB");
  });

  test("cancelling the erase confirmation stays on the summary", async ({
    page,
  }) => {
    await openConfirmation(page);
    await nextButton(page).click();

    const dialog = page.locator("confirm-dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator('wa-button[appearance="outlined"]').click();

    await expect(dialog).toBeHidden();
    await expect(page.locator("confirmation-view")).toBeVisible();
    await expect(page.locator("progress-view")).toBeHidden();
  });

  test("dismissing with Escape stays on the summary", async ({ page }) => {
    await openConfirmation(page);
    await nextButton(page).click();

    const dialog = page.locator("confirm-dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");

    await expect(dialog).toBeHidden();
    await expect(page.locator("confirmation-view")).toBeVisible();
  });

  test("confirming starts the write on the drive that was shown", async ({
    page,
  }) => {
    await openConfirmation(page);
    await nextButton(page).click();

    const dialog = page.locator("confirm-dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator('wa-button[variant="danger"]').click();

    await expect(page.locator("progress-view")).toBeVisible();
  });
});
