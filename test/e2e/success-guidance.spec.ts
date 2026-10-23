import { test, expect, type Page } from "@playwright/test";
import { skipWifiStep } from "./fixtures.js";

const next = (page: Page) =>
  page.locator("wizard-shell .footer-right wa-button");

// The ODROID-N2 has the longest next steps
test("next steps fit a 390px window after the browser mock flash", async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  const width = 390;
  await page.setViewportSize({ width, height: 850 });
  // The Vite development build uses browser mocks when Tauri is absent.
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .locator('option-card[heading="Raspberry Pi & other boards"]')
    .click();
  await page.locator('device-card[value="odroid-n2"]').click();
  await next(page).click();
  await page.locator("drive-selection-view drive-card").first().click();
  await next(page).click();
  await skipWifiStep(page);
  await next(page).click();
  await page.locator('confirm-dialog wa-button[variant="danger"]').click();

  const success = page.locator("success-view");
  await expect(success).toBeVisible({ timeout: 45000 });

  // Check the changed content, not the pre-existing overflowing step header.
  const layout = await success.locator(".next-steps").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const steps = [...element.querySelectorAll(".step-item")].map((step) =>
      step.getBoundingClientRect()
    );
    return {
      left: bounds.left,
      right: bounds.right,
      overflowing: [
        ...element.querySelectorAll(".step-text, .next-steps-footer"),
      ].some((item) => item.scrollWidth > item.clientWidth + 1),
      overlappingSteps: steps.some(
        (step, index) => index > 0 && steps[index - 1].bottom > step.top + 1
      ),
    };
  });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(width);
  expect(layout.overflowing).toBe(false);
  expect(layout.overlappingSteps).toBe(false);

  for (const [section, target] of [
    ["top", success.locator("h2")],
    ["next-steps", success.locator(".next-steps-footer")],
  ] as const) {
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeInViewport();
    const screenshot = testInfo.outputPath(`success-guidance-${section}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach(`browser-mock-success-guidance-${section}`, {
      path: screenshot,
      contentType: "image/png",
    });
  }
});

test("a Wi-Fi network set on its own step replaces the cable step", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .locator('option-card[heading="Raspberry Pi & other boards"]')
    .click();
  await page.locator('device-card[value="rpi5"]').click();
  await next(page).click();
  await page.locator("drive-selection-view drive-card").first().click();
  await next(page).click();

  const step = page.locator("wifi-view");
  await step.locator('wa-switch [part="control"]').click();
  await step.locator("#wifi-ssid").fill("Home");
  await step.locator("#wifi-password").fill("1234567");
  // Leaving the field says why Next is off
  const tooShort = step.getByText("Use at least 8 characters.");
  await expect(tooShort).toHaveCount(0);
  await step.locator("#wifi-password").blur();
  await expect(tooShort).toBeVisible();
  await step.locator("#wifi-password").fill("12345678");
  await expect(tooShort).toHaveCount(0);
  await expect(next(page)).toHaveJSProperty("disabled", false);
  await next(page).click();

  await expect(page.locator("confirmation-view")).toContainText("Wi-Fi");
  await next(page).click();
  await page.locator('confirm-dialog wa-button[variant="danger"]').click();

  const steps = page.locator("success-view .next-steps");
  await expect(steps).toContainText("joins the Wi-Fi network Home", {
    timeout: 45000,
  });
  await expect(steps).not.toContainText("Ethernet cable to the same network");
  await expect(steps).not.toContainText("Keep power and Ethernet connected");
});
