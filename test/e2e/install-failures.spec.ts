import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

test.use({ platform: "macos" });

const next = (page: Page) =>
  page.locator("wizard-shell .footer-right wa-button");

// Recovery follows each error's retryability: a retry, picking the drive
// again, or only cancelling when a retry could repeat a hidden VM creation.
for (const scenario of [
  {
    failure: "flash-write",
    flow: "sbc",
    message:
      "The drive is in use. Close any applications using it, then try again.",
    recovery: "retry",
  },
  {
    failure: "flash-disconnected",
    flow: "sbc",
    message:
      "The storage device was disconnected. Reconnect it and select your drive again.",
    recovery: "choose-drive",
  },
  {
    failure: "proxmox-install",
    flow: "proxmox",
    message:
      "Proxmox could not complete the request. Check the server, account permissions, and connection.",
    recovery: "cancel",
  },
  {
    failure: "utm-create",
    flow: "utm",
    message: "UTM error: Automation permission denied",
    recovery: "retry",
  },
] as const) {
  test(`${scenario.failure} shows an error and recovers through the real wizard flow`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90000);
    // Set before navigation, but consume once so the same page's retry succeeds.
    await page.addInitScript((failure) => {
      sessionStorage.setItem("hai:mock-failure", failure);
    }, scenario.failure);
    await page.goto("/");
    await page.locator("welcome-view wa-button").click();
    if (scenario.flow === "sbc") {
      await page
        .locator('option-card[title="Raspberry Pi & other boards"]')
        .click();
      await page.locator("device-selection-view device-card").first().click();
      await next(page).click();
      await page.locator("drive-selection-view drive-card").first().click();
      await next(page).click();
      await expect(page.locator("confirmation-view")).toBeVisible();
      await next(page).click();
      await page.locator('confirm-dialog wa-button[variant="danger"]').click();
    } else {
      await page
        .locator(
          `option-card[title="${scenario.flow === "utm" ? "Virtual machine" : "Proxmox server"}"]`
        )
        .click();
      if (scenario.flow === "proxmox") {
        const connect = page.locator("proxmox-connect-view");
        await connect.locator("#server-url").fill("https://192.0.2.10:8006");
        await connect.locator("#username").fill("test@pam");
        await connect.locator("#password").fill("test-only");
      }
      await expect(next(page)).toHaveJSProperty("disabled", false);
      await next(page).click();
      await expect(
        page.locator(`${scenario.flow}-configure-view`)
      ).toBeVisible();
      await expect(next(page)).toHaveJSProperty("disabled", false);
      await next(page).click();
      await expect(page.locator(`${scenario.flow}-confirm-view`)).toBeVisible();
      await next(page).click();
    }
    const prefix = scenario.flow === "sbc" ? "" : `${scenario.flow}-`;
    const progress = page.locator(`${prefix}progress-view`);
    await expect(progress.locator(".error-message")).toHaveText(
      scenario.message,
      { timeout: 30000 }
    );
    await expect(page.locator(`${prefix}success-view`)).toHaveCount(0);
    if (scenario.recovery === "retry") {
      await expect(next(page)).toHaveText("Try again");
    } else if (scenario.recovery === "choose-drive") {
      await expect(next(page)).toHaveText("Choose another drive");
    } else {
      await expect(next(page)).not.toBeVisible();
    }
    await expect(
      page.locator("wizard-shell .footer-left wa-button")
    ).toHaveText("Cancel");
    await expect
      .poll(() =>
        page.evaluate(() => sessionStorage.getItem("hai:mock-failure"))
      )
      .toBe(null);
    const screenshot = testInfo.outputPath("failure.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach("failure", {
      path: screenshot,
      contentType: "image/png",
    });
    if (scenario.recovery === "cancel") {
      await page.locator("wizard-shell .footer-left wa-button").click();
      await expect(page.locator("welcome-view")).toBeVisible();
      return;
    }
    await next(page).click();
    if (scenario.recovery === "choose-drive") {
      await page.locator("drive-selection-view drive-card").first().click();
      await next(page).click();
      await expect(page.locator("confirmation-view")).toBeVisible();
      await next(page).click();
      await page.locator('confirm-dialog wa-button[variant="danger"]').click();
    }
    await expect(progress.locator(".error-message")).toHaveCount(0);
    await expect(page.locator("wizard-shell .footer")).not.toBeVisible();
    await expect(page.locator(`${prefix}success-view`)).toBeVisible({
      timeout: 45000,
    });
    await expect(next(page)).toHaveText("Done");
    await next(page).click();
    await expect(page.locator("welcome-view")).toBeVisible();
  });
}
