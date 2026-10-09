import { test, expect, type Page } from "@playwright/test";

const next = (page: Page) =>
  page.locator("wizard-shell .footer-right wa-button");

for (const width of [1100, 390]) {
  for (const scenario of [
    { device: "rpi5", text: "Insert the written storage into Raspberry Pi 5" },
    { device: "odroid-n2", text: "flashed the board directly over USB" },
    { device: "odroid-m1s", text: "flashed the board directly over USB" },
    { device: "generic-x86-64", text: "written drive in your mini PC" },
    { device: "generic-aarch64", text: "written drive in your mini PC" },
  ]) {
    test(`${width}px ${scenario.device} shows next steps after the browser mock flash`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(60000);
      await page.setViewportSize({ width, height: 850 });
      // The Vite development build uses browser mocks when Tauri is absent.
      await page.goto("/");
      await page.locator("welcome-view wa-button").click();
      if (scenario.device.startsWith("generic-")) {
        await page.locator('option-card[title="Generic (mini) PC"]').click();
        await page
          .locator("minipc-setup-method-view")
          .locator("option-card, wa-radio")
          .filter({ hasText: "I can connect the drive" })
          .click();
        await page
          .locator("minipc-architecture-selection-view")
          .locator("option-card, wa-radio")
          .filter({
            hasText: scenario.device === "generic-x86-64" ? "Intel/AMD" : "ARM",
          })
          .click();
      } else {
        await page
          .locator('option-card[title="Raspberry Pi & other boards"]')
          .click();
        await page.locator(`device-card[value="${scenario.device}"]`).click();
      }
      await next(page).click();
      await page.locator("drive-selection-view drive-card").first().click();
      await next(page).click();
      await expect(page.locator("confirmation-view")).toBeVisible();
      await next(page).click();
      await page.locator('confirm-dialog wa-button[variant="danger"]').click();

      const success = page.locator("success-view");
      await expect(success).toBeVisible({ timeout: 45000 });
      await expect(success.locator(".next-steps")).toContainText(scenario.text);
      await expect(success.locator(".next-steps")).toContainText(
        "internet access"
      );
      await expect(success.locator(".next-steps")).toContainText(
        "Preparing Home Assistant"
      );
      await expect(success.locator(".next-steps")).toContainText(
        "about 20 minutes"
      );
      await expect(success.locator(".next-steps")).toContainText(
        "router or on an attached display"
      );
      await expect(success.locator(".notice")).toContainText(
        "Do not format or initialize the written drive."
      );
      await expect(success.locator(".notice")).toContainText(
        "Choose Cancel if offered, or Ignore or Eject on macOS."
      );
      await expect(success.locator(".next-steps-footer a")).toBeVisible();
      await expect(next(page)).toHaveText("Done");
      await expect(success.locator(".next-steps")).toContainText(
        "If it still does not open after a few minutes"
      );
      if (scenario.device === "odroid-m1s") {
        await expect(success.locator(".next-steps")).toContainText(
          "With the board powered off, remove the EMMC2UMS SD card if you used one."
        );
        await expect(success.locator(".next-steps")).not.toContainText(
          "boot mode switch"
        );
      } else if (scenario.device === "odroid-n2") {
        await expect(success.locator(".next-steps")).toContainText(
          "set the boot mode switch back to MMC"
        );
        await expect(success.locator(".next-steps")).not.toContainText(
          "EMMC2UMS"
        );
      }

      // Check the changed content, not the pre-existing overflowing step header.
      const layout = await success
        .locator(".next-steps")
        .evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const steps = [...element.querySelectorAll(".step-item")].map(
            (step) => step.getBoundingClientRect()
          );
          return {
            left: bounds.left,
            right: bounds.right,
            overflowing: [
              ...element.querySelectorAll(
                ".step-text, .notice, .next-steps-footer"
              ),
            ].some((item) => item.scrollWidth > item.clientWidth + 1),
            overlappingSteps: steps.some(
              (step, index) =>
                index > 0 && steps[index - 1].bottom > step.top + 1
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
        const screenshot = testInfo.outputPath(
          `success-guidance-${section}.png`
        );
        await page.screenshot({ path: screenshot });
        await testInfo.attach(`browser-mock-success-guidance-${section}`, {
          path: screenshot,
          contentType: "image/png",
        });
      }
      await next(page).click();
      await expect(page.locator("welcome-view")).toBeVisible();
    });
  }
}
