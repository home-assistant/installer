import { type Page } from "@playwright/test";
import { skipWifiStep, test, expect } from "./fixtures.js";

// The browser mock serves the device catalog, the drives and a simulated
// write, so a device can go all the way to its next steps.

const next = (page: Page) =>
  page.locator("wizard-shell .footer-right wa-button");
// The reinstall dialog has a header with a close button of its own
const back = (page: Page) =>
  page.locator("wizard-shell .header:has(step-indicator) > wa-button");
const cancel = (page: Page) =>
  page.locator("wizard-shell .footer-left wa-button");

const reinstallDialog = (page: Page) =>
  page.locator("ha-hardware-device-selection-view info-dialog");

/** Picks `device`, going on past the reinstall dialog it opens. */
async function pickDevice(page: Page, device: string) {
  await page.locator(`device-card[value="${device}"]`).click();
  await reinstallDialog(page)
    .getByRole("button", { name: /^(Reinstall|Install)$/ })
    .click();
}

/** Picks the Yellow's compute module on its own step, which goes on. */
async function pickModule(page: Page, module: string) {
  await page
    .locator(`ha-hardware-module-selection-view option-card[value="${module}"]`)
    .click();
}

async function openHaHardware(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.locator('option-card[heading="Home Assistant hardware"]').click();
  await expect(
    page.locator("ha-hardware-device-selection-view device-card").first()
  ).toBeVisible();
}

test.describe("Home Assistant hardware flow", () => {
  test("lists each device, with one Yellow", async ({ page }) => {
    await openHaHardware(page);

    const cards = page.locator("ha-hardware-device-selection-view device-card");
    await expect(cards).toHaveCount(3);
    for (const name of [
      "Home Assistant Green",
      "Home Assistant Yellow",
      "Home Assistant Blue",
    ]) {
      await expect(
        page.getByRole("button", { name, exact: true })
      ).toBeVisible();
    }
    // Picking a device goes on, so there is no Next
    await expect(next(page)).toHaveCount(0);
    // Back leads out of the flow, to the path selection
    await back(page).click();
    await expect(page.locator("path-selection-view")).toBeVisible();
  });

  test("picking asks before reinstalling, and Go back stays on the device step", async ({
    page,
  }) => {
    await openHaHardware(page);
    await page.locator('device-card[value="ha-green"]').click();

    const dialog = reinstallDialog(page);
    await expect(dialog).toBeVisible();
    const goBack = dialog.locator("wa-button", { hasText: "Go back" });

    await goBack.click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator("drive-selection-view")).toHaveCount(0);
    await expect(page.locator('device-card[value="ha-green"]')).toBeFocused();
  });

  test("the Green installs through to the success screen, and Done returns to the start", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await openHaHardware(page);

    await pickDevice(page, "ha-green");

    const drive = page.locator("drive-selection-view");
    await drive.locator("drive-card").first().click();
    await next(page).click();
    await skipWifiStep(page);

    await next(page).click();
    await page.locator('confirm-dialog wa-button[variant="danger"]').click();
    await expect(page.locator("progress-view")).toBeVisible();

    await expect(page.locator("ha-hardware-success-view")).toBeVisible({
      timeout: 45000,
    });
    // Then the device starts, which can be skipped, and the flow is done
    await next(page).click();
    await expect(page.locator("device-setup-view")).toBeVisible();
    await next(page).click();
    await expect(page.locator("device-done-view")).toBeVisible();
    await next(page).click();
    await expect(page.locator("path-selection-view")).toBeVisible();
  });

  test("the Yellow asks for its compute module after the dialog", async ({
    page,
  }) => {
    await openHaHardware(page);
    await page.locator('device-card[value="ha-yellow"]').click();
    await expect(page.locator("step-indicator")).toContainText("Select module");
    await reinstallDialog(page)
      .getByRole("button", { name: "Install", exact: true })
      .click();

    const modules = page.locator("ha-hardware-module-selection-view");
    await expect(modules).toContainText("Select your compute module");
    await expect(modules.locator("option-card")).toHaveCount(2);
    await expect(next(page)).toHaveCount(0);
    await pickModule(page, "yellow-cm4");
    await expect(page.locator("drive-selection-view")).toBeVisible();
  });

  test("Back keeps the device and Cancel leaves the flow", async ({ page }) => {
    await openHaHardware(page);
    await pickDevice(page, "ha-yellow");
    await pickModule(page, "yellow-cm5");
    await expect(
      page.locator("ha-hardware-connect-instructions")
    ).toContainText("Set jumper JP1 to USB");

    await back(page).click();
    await expect(
      page.locator("ha-hardware-module-selection-view")
    ).toBeVisible();

    // Another module is prepared differently, so its instructions follow.
    await pickModule(page, "yellow-cm4");
    await expect(
      page.locator("ha-hardware-connect-instructions")
    ).toContainText("USB flash drive");

    await back(page).click();
    await back(page).click();
    await expect(
      page.locator("ha-hardware-device-selection-view")
    ).toBeVisible();
    // Still the Yellow, whose compute module has a step of its own
    await expect(page.locator("step-indicator")).toContainText("Select module");

    await cancel(page).click();
    await expect(page.locator("path-selection-view")).toBeVisible();
  });
});
