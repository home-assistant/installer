import { test, expect, type Page } from "@playwright/test";

// Browser-only mode serves the mock block devices from src/api/mock-data.ts.
// Importing that module from the page returns the instance the app uses, so
// a test can change what the next device scan reports.

const nextButton = (page: Page) =>
  page.locator("wizard-shell").locator(".footer-right wa-button");

async function openConfirmation(page: Page) {
  await page.goto("/");
  await page.locator("welcome-view").locator("wa-button").click();
  await page
    .locator('option-card[title="Raspberry Pi & other boards"]')
    .click();

  const deviceView = page.locator("device-selection-view");
  await deviceView.locator("device-card").first().click();
  await nextButton(page).click();

  const driveView = page.locator("drive-selection-view");
  await driveView.locator("drive-card").first().click();
  await nextButton(page).click();

  await expect(page.locator("confirmation-view")).toBeVisible();
}

/** Simulate another drive being plugged in under the selected drive's path. */
async function swapSelectedDrive(page: Page) {
  await page.evaluate(async () => {
    // Paths as the Vite dev server serves them, not resolvable by tsc.
    const mockData = "/src/api/mock-data.ts";
    const state = "/src/state/wizard-state.ts";
    const { MOCK_BLOCK_DEVICES } = (await import(
      mockData
    )) as typeof import("../../src/api/mock-data.js");
    const { wizardState } = (await import(
      state
    )) as typeof import("../../src/state/wizard-state.js");
    const id = wizardState.getState().selections.drive;
    const drive = MOCK_BLOCK_DEVICES.find((d) => d.id === id)!;
    drive.model = "A Different Stick";
  });
}

test.describe("SBC Flow - drive swapped after selection", () => {
  for (const serial of ["REPLACEMENT-SERIAL", null]) {
    test(`erase confirmation rejects an identical model with serial ${serial === null ? "missing" : "changed"}`, async ({
      page,
    }) => {
      await openConfirmation(page);
      await nextButton(page).click();
      const dialog = page.locator("confirm-dialog");
      await expect(dialog.locator(".detail-value.path")).toBeVisible();
      await page.evaluate(async (serial) => {
        const mockData = "/src/api/mock-data.ts";
        const state = "/src/state/wizard-state.ts";
        const { MOCK_BLOCK_DEVICES } = (await import(
          mockData
        )) as typeof import("../../src/api/mock-data.js");
        const { wizardState } = (await import(
          state
        )) as typeof import("../../src/state/wizard-state.js");
        const selected = MOCK_BLOCK_DEVICES.find(
          (drive) => drive.id === wizardState.getState().selections.drive
        )!;
        if (!wizardState.getState().selections.driveSerial)
          throw new Error("Fixture must select a drive with a known serial");
        selected.serial = serial;
      }, serial);
      await dialog.locator('wa-button[variant="danger"]').click();
      await expect(page.locator("drive-selection-view")).toBeVisible();
      await expect(page.locator("progress-view")).not.toBeVisible();
      await expect(nextButton(page)).toHaveJSProperty("disabled", true);
    });
  }

  test("Install sends the user back to pick the drive again", async ({
    page,
  }) => {
    await openConfirmation(page);
    await swapSelectedDrive(page);

    await nextButton(page).click();

    const driveView = page.locator("drive-selection-view");
    await expect(driveView).toBeVisible();
    await expect(driveView.locator(".notice")).toBeVisible();
    await expect(page.locator("confirm-dialog")).not.toBeVisible();
    await expect(nextButton(page)).toHaveJSProperty("disabled", true);
  });

  test("confirming the erase does not start the write", async ({ page }) => {
    await openConfirmation(page);
    await nextButton(page).click();
    const dialog = page.locator("confirm-dialog");
    await expect(dialog.locator(".detail-value.path")).toBeVisible();

    await swapSelectedDrive(page);
    await dialog.locator('wa-button[variant="danger"]').click();

    await expect(page.locator("drive-selection-view")).toBeVisible();
    await expect(page.locator("progress-view")).toHaveCount(0);
  });
});
