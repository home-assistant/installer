import type { Page } from "@playwright/test";
import {
  approveProxmoxImport,
  test,
  expect,
  skipWifiStep,
} from "./fixtures.js";

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
  // Not retryable right away, but the drive is fine once access is allowed
  {
    failure: "flash-permission",
    flow: "sbc",
    message: "Administrator access was denied",
    recovery: "retry",
  },
  {
    failure: "proxmox-install",
    flow: "proxmox",
    message:
      "Proxmox could not complete the request. Check the server, account permissions, and connection.",
    recovery: "cancel",
  },
  // Before the VM exists, so nothing is left on the server to trip a retry
  {
    failure: "proxmox-download",
    flow: "proxmox",
    message:
      "The image could not be downloaded. Check your connection and available storage.",
    recovery: "retry",
  },
  {
    failure: "utm-create",
    flow: "utm",
    message:
      "Home Assistant Installer is not allowed to control UTM. Open System Settings > Privacy & Security > Automation, enable UTM under Home Assistant Installer, then try again.",
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
    await page.getByRole("button", { name: "Let's go" }).click();
    if (scenario.flow === "sbc") {
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
    } else {
      await page
        .locator(
          `option-card[heading="${scenario.flow === "utm" ? "Virtual machine" : "Proxmox server"}"]`
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
      if (scenario.flow === "proxmox") await approveProxmoxImport(page);
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
      await skipWifiStep(page);
      await next(page).click();
      await page.locator('confirm-dialog wa-button[variant="danger"]').click();
    }
    await expect(progress.locator(".error-message")).toHaveCount(0);
    // A running flash offers Cancel only; the VM installs show no buttons
    // while the VM is being created, in a footer that stays in place
    if (scenario.flow === "sbc") {
      await expect(next(page)).toHaveCount(0);
      await expect(
        page.locator("wizard-shell .footer-left wa-button")
      ).toHaveText("Cancel");
    } else {
      const cancel = page.locator("wizard-shell .footer-left wa-button");
      await expect(cancel).toHaveText("Cancel");
      await expect(cancel).not.toBeVisible({ timeout: 20000 });
      // Hidden by the install itself, not by the success step after it
      await expect(progress).toBeVisible();
      await expect(page.locator("wizard-shell .footer-left")).toBeVisible();
    }
    await expect(page.locator(`${prefix}success-view`)).toBeVisible({
      timeout: 45000,
    });
    await expect(next(page)).toHaveText("Done");
    await next(page).click();
    await expect(page.locator("welcome-view")).toBeVisible();
  });
}
