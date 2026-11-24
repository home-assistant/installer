import { type Page } from "@playwright/test";
import {
  flowScreenshot,
  MOCK_DELAY_SCALE,
  setMockDelayScale,
  skipWifiStep,
  test,
  expect,
} from "./fixtures.js";

// Browser-only mode serves the mock block devices from src/api/mock-data.ts.
// Importing that module from the page returns the instance the app uses, so
// a test can change what the next device scan reports.

const nextButton = (page: Page) =>
  page.locator("wizard-shell").locator(".footer-right wa-button");

async function openConfirmation(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .locator('option-card[heading="Raspberry Pi & other boards"]')
    .click();

  const deviceView = page.locator("device-selection-view");
  await deviceView.locator("device-card").first().click();

  const driveView = page.locator("drive-selection-view");
  await driveView.locator("drive-card").first().click();
  await nextButton(page).click();

  await skipWifiStep(page);
}

test("SBC Flow - installs a board through to the done step", async ({
  page,
}) => {
  test.setTimeout(60000);
  const shot = (step: string) => flowScreenshot(page, "sbc", step);
  await page.goto("/");
  await expect(page.locator("welcome-view")).toBeVisible();
  await shot("welcome");
  await page.getByRole("button", { name: "Let's go" }).click();
  await expect(page.locator("path-selection-view")).toBeVisible();
  await shot("path-selection");
  await page
    .locator('option-card[heading="Raspberry Pi & other boards"]')
    .click();

  const deviceView = page.locator("device-selection-view");
  await expect(deviceView.locator("device-card").first()).toBeVisible();
  await shot("device");
  await deviceView.locator("device-card").first().click();

  const drive = page.locator("drive-selection-view");
  await drive.locator("drive-card").first().click();
  await shot("drive");
  await nextButton(page).click();
  await expect(
    page.locator("wifi-view, confirmation-view").first()
  ).toBeVisible();
  if ((await page.locator("wifi-view").count()) > 0) await shot("wifi");
  await skipWifiStep(page);
  await shot("confirm");

  await nextButton(page).click();
  await expect(page.locator("confirm-dialog")).toHaveAttribute("open");
  await shot("erase-dialog");
  await setMockDelayScale(page, 1);
  await page.locator('confirm-dialog wa-button[variant="danger"]').click();
  await expect(page.locator("progress-view")).toBeVisible();
  await shot("progress");
  await setMockDelayScale(page, MOCK_DELAY_SCALE);

  await expect(page.locator("success-view")).toBeVisible({ timeout: 45000 });
  await shot("success");
  await nextButton(page).click();
  await expect(page.locator("device-setup-view")).toBeVisible();
  await shot("setup");
  await nextButton(page).click();
  await expect(page.locator("device-done-view")).toBeVisible();
  await shot("done");
});

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
});
