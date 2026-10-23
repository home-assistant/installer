import type { Page } from "@playwright/test";
import { expect, skipWifiStep, test } from "./fixtures.js";

const next = (page: Page) =>
  page.locator("wizard-shell .footer-right wa-button");
// The error screen has dialogs with a header of their own
const back = (page: Page) => page.locator("wizard-shell .back");

// "Try again" writes the same drive and Cancel drops every choice, so Back is
// the way to change the drive or the Wi-Fi once the flash was stopped
test("Back after a stopped flash leads to another drive, asking again before erasing", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .locator('option-card[heading="Raspberry Pi & other boards"]')
    .click();
  await page.locator("device-selection-view device-card").first().click();
  await next(page).click();
  await page.locator("drive-selection-view drive-card").first().click();
  await next(page).click();
  await skipWifiStep(page);
  await next(page).click();
  await page.locator('confirm-dialog wa-button[variant="danger"]').click();

  await expect(page.locator("progress-view")).toBeVisible();
  await expect(back(page)).toHaveCSS("visibility", "hidden");

  await page.locator("wizard-shell .footer-left wa-button").click();
  await page
    .locator("app-shell > info-dialog.stop-dialog")
    .getByRole("button", { name: "Stop installation" })
    .click();
  await expect(page.locator("progress-view .error-message")).toContainText(
    "Installation stopped."
  );
  await expect(next(page)).toHaveText("Try again");
  await expect(back(page)).toBeVisible();

  await back(page).click();
  const confirmation = page.locator("confirmation-view");
  await expect(confirmation).toBeVisible();
  await expect(page.locator('step-indicator [aria-current="step"]')).toHaveText(
    "Confirm"
  );
  // Like every other step that opens, it starts from its heading
  await expect(confirmation.getByRole("heading").first()).toBeFocused();
  await expect(next(page)).toHaveText("Install");

  // Back past the Wi-Fi, if the board has it, to the drive
  await back(page).click();
  if ((await page.locator("wifi-view").count()) > 0) await back(page).click();
  await expect(page.locator("drive-selection-view")).toBeVisible();
  const other = page.locator("drive-selection-view drive-card").nth(1);
  const otherName = await other.evaluate(
    (card) => (card as HTMLElement & { name: string }).name
  );
  await other.click();
  await next(page).click();
  await skipWifiStep(page);

  await next(page).click();
  const dialog = page.locator("confirm-dialog[open]");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".drive-name")).toHaveText(otherName);
  await dialog.locator('wa-button[variant="danger"]').click();

  // A new write, offering only Cancel again
  await expect(page.locator("progress-view")).toBeVisible();
  await expect(page.locator("progress-view .error-message")).toHaveCount(0);
  await expect(back(page)).toHaveCSS("visibility", "hidden");
  await expect(next(page)).toHaveCount(0);
  await expect(page.locator("wizard-shell .footer-left wa-button")).toHaveText(
    "Cancel"
  );
});
