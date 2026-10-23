import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

test.use({ platform: "macos" });

test.describe("UTM Installation Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Let's go" }).click();
    await expect(page.locator("path-selection-view")).toBeVisible();

    const vmOption = page.locator('option-card[heading="Virtual machine"]');
    await expect(vmOption).toBeVisible();
    await vmOption.click();

    await expect(page.locator("wizard-shell")).toBeVisible();
  });

  test("step 1: offers the UTM download until UTM is installed", async ({
    page,
  }) => {
    // Answer the UTM check from here, starting with UTM missing
    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        isTauri: boolean;
        utmInstalled: boolean;
        unexpectedCommands: string[];
        __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> };
      };
      testWindow.utmInstalled = false;
      testWindow.unexpectedCommands = [];
      testWindow.isTauri = true;
      testWindow.__TAURI_INTERNALS__ = {
        invoke: async (cmd) => {
          if (cmd === "check_utm_status")
            return testWindow.utmInstalled
              ? {
                  installed: true,
                  path: "/Applications/UTM.app",
                  version: "4.6.0",
                }
              : { installed: false, path: null, version: null };
          if (cmd === "utm_supported") return true;
          // macOS lets the installer control UTM
          if (cmd === "check_utm_automation") return undefined;
          if (cmd === "check_connection" || cmd === "log_frontend_event")
            return undefined;
          // A misspelled command would otherwise pass as "no answer"
          testWindow.unexpectedCommands.push(cmd);
          return undefined;
        },
      };
    });
    const wizardShell = page.locator("wizard-shell");
    await wizardShell.locator(".footer-left wa-button").click();
    await page.getByRole("button", { name: "Let's go" }).click();
    const vmOption = page.locator('option-card[heading="Virtual machine"]');
    // Answered as an Apple silicon Mac, not one that can't run the VM
    await expect(vmOption).toContainText("in the free UTM app");
    await vmOption.click();

    const checkView = page.locator("utm-check-view");
    const next = wizardShell.locator(".footer-right wa-button");
    await expect(checkView.locator(".status-title")).toHaveText(
      "UTM is not installed"
    );
    await expect(
      checkView.locator("wa-button[appearance='accent']")
    ).toContainText("Download UTM");
    await expect(next).toHaveJSProperty("disabled", true);

    // Installed meanwhile: checking again lets the user continue
    await page.evaluate(() => {
      (window as typeof window & { utmInstalled: boolean }).utmInstalled = true;
    });
    await checkView.locator("wa-button[appearance='outlined']").click();
    await expect(checkView.locator(".status-title")).toHaveText(
      "UTM is installed (v4.6.0)"
    );
    await expect(next).toHaveJSProperty("disabled", false);
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { unexpectedCommands: string[] })
            .unexpectedCommands
      )
    ).toEqual([]);
  });

  test("step 2: a double-click on Next stops at the confirmation", async ({
    page,
  }) => {
    await navigateToUtmStep2(page);

    await page
      .locator("wizard-shell")
      .locator(".footer-right wa-button")
      .dblclick();

    await expect(page.locator("utm-confirm-view")).toBeVisible();
    await expect(page.locator("utm-progress-view")).toHaveCount(0);
  });

  test("can navigate back through each step", async ({ page }) => {
    await navigateToUtmStep3(page);

    const backButton = page
      .locator("wizard-shell")
      .locator(".header wa-button");
    await expect(backButton).toHaveJSProperty("disabled", false);
    await backButton.click();

    // Should go back to configure view
    await expect(page.locator("utm-configure-view")).toBeVisible();

    await backButton.click();
    await expect(page.locator("utm-check-view")).toBeVisible();
  });

  test("can cancel wizard at any step before installation", async ({
    page,
  }) => {
    const wizardShell = page.locator("wizard-shell");

    // Test cancel on step 1
    await wizardShell.locator(".footer-left wa-button").click();
    await expect(page.locator("welcome-view")).toBeVisible();

    // Restart flow
    await page.getByRole("button", { name: "Let's go" }).click();
    const vmOption = page.locator('option-card[heading="Virtual machine"]');
    await expect(vmOption).toBeVisible();
    await vmOption.click();

    // Test cancel on step 2
    await navigateToUtmStep2(page);
    await wizardShell.locator(".footer-left wa-button").click();
    await expect(page.locator("welcome-view")).toBeVisible();
  });

  test("complete end-to-end flow", async ({ page }) => {
    // Step 1: Check UTM
    await expect(page.locator("utm-check-view")).toBeVisible();

    // Verify we can proceed (UTM installed in mock mode)
    const nextButton = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");

    await expect(nextButton).toHaveJSProperty("disabled", false);

    await nextButton.click();

    // Step 2: Configure
    await expect(page.locator("utm-configure-view")).toBeVisible();
    await page
      .locator("wizard-shell")
      .locator(".footer-right wa-button")
      .click();

    // Step 3: Confirm - click Install (no confirmation dialog for VM flow)
    await expect(page.locator("utm-confirm-view")).toBeVisible();
    await page
      .locator("wizard-shell")
      .locator(".footer-right wa-button")
      .click();

    // Step 4: Progress (proceeds directly, no dialog)
    await expect(page.locator("utm-progress-view")).toBeVisible();
    await expect(page.locator("wizard-shell .header wa-button")).toHaveCSS(
      "visibility",
      "hidden"
    );

    // Step 5: Success
    await expect(page.locator("utm-success-view")).toBeVisible({
      timeout: 30000,
    });

    // Return to welcome
    await page
      .locator("wizard-shell")
      .locator(".footer-right wa-button")
      .click();
    await expect(page.locator("welcome-view")).toBeVisible();
  });
});

// Helper functions to navigate to specific steps
async function navigateToUtmStep2(page: Page) {
  const nextButton = page
    .locator("wizard-shell")
    .locator(".footer-right wa-button");

  // Enabled once the UTM check found UTM installed
  await expect(nextButton).toHaveJSProperty("disabled", false);
  await nextButton.click();
  await expect(page.locator("utm-configure-view")).toBeVisible();
}

async function navigateToUtmStep3(page: Page) {
  await navigateToUtmStep2(page);
  await page.locator("wizard-shell").locator(".footer-right wa-button").click();
  await expect(page.locator("utm-confirm-view")).toBeVisible();
}
