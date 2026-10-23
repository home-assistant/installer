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

  test("shows wizard shell with correct flow title", async ({ page }) => {
    const wizardShell = page.locator("wizard-shell");
    await expect(wizardShell).toContainText("Virtual machine");
  });

  test("shows step indicator with all steps", async ({ page }) => {
    const stepIndicator = page.locator("step-indicator");
    await expect(stepIndicator).toBeVisible();
    // Should show: Check requirements, Configure VM, Confirm, Install, Done
    await expect(stepIndicator).toContainText("Check requirements");
    await expect(stepIndicator).toContainText("Configure VM");
    await expect(stepIndicator).toContainText("Confirm");
    await expect(stepIndicator).toContainText("Install");
    await expect(stepIndicator).toContainText("Done");
  });

  test("step 1: shows UTM check view", async ({ page }) => {
    const checkView = page.locator("utm-check-view");
    await expect(checkView).toBeVisible();
  });

  test("step 1: shows UTM status check heading", async ({ page }) => {
    const checkView = page.locator("utm-check-view");
    await expect(checkView.locator("h2")).toContainText(
      "Virtual machine setup"
    );
  });

  test("step 1: says what a virtual machine is good for", async ({ page }) => {
    const checkView = page.locator("utm-check-view");
    const note = checkView.locator(".testing-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("Good for trying Home Assistant");
    await expect(note).toContainText("while your Mac is on");
    await expect(checkView.locator("inline-notice")).toHaveCount(0);
  });

  test("step 1: shows the supplied Casita status artwork", async ({ page }) => {
    const checkView = page.locator("utm-check-view");
    const mascot = checkView.locator("casita-mascot img");
    await expect(mascot).toBeVisible();
    await expect(mascot).toHaveAttribute("src", "/assets/casita/Happy.svg");
  });

  test("step 1: shows loading state initially", async ({ page }) => {
    // Hold the UTM check from here, so the view stays on its loading state
    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        isTauri: boolean;
        __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> };
      };
      testWindow.isTauri = true;
      testWindow.__TAURI_INTERNALS__ = {
        invoke: (cmd) =>
          cmd === "check_utm_status"
            ? new Promise(() => {})
            : Promise.resolve(cmd === "utm_supported" ? true : undefined),
      };
    });
    const wizardShell = page.locator("wizard-shell");
    await wizardShell.locator(".footer-left wa-button").click();
    await page.getByRole("button", { name: "Let's go" }).click();
    await page.locator('option-card[heading="Virtual machine"]').click();

    const checkView = page.locator("utm-check-view");
    await expect(checkView.locator(".status-title")).toHaveText(
      "Checking for UTM..."
    );
    await expect(
      wizardShell.locator(".footer-right wa-button")
    ).toHaveJSProperty("disabled", true);
  });

  test("step 1: shows UTM status after check completes", async ({ page }) => {
    // The browser mock has UTM 4.5.0 installed
    const checkView = page.locator("utm-check-view");
    await expect(checkView.locator(".status-title")).toHaveText(
      "UTM is installed (v4.5.0)"
    );
    await expect(checkView).toContainText(
      "Ready to create a Home Assistant virtual machine"
    );
    await expect(checkView.locator("wa-button")).toHaveCount(0);
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

  test("step 1: next button state depends on UTM installation", async ({
    page,
  }) => {
    const nextButton = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");

    // UTM is installed in mock mode, so the Next button is enabled.
    await expect(nextButton).toHaveJSProperty("disabled", false);
  });

  test("step 1: can navigate to step 2 when UTM is installed", async ({
    page,
  }) => {
    const nextButton = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");

    await expect(nextButton).toHaveJSProperty("disabled", false);
    await nextButton.click();
    await expect(page.locator("utm-configure-view")).toBeVisible();
  });

  test("step 2: shows VM configuration view", async ({ page }) => {
    await navigateToUtmStep2(page);

    const configView = page.locator("utm-configure-view");
    await expect(configView).toBeVisible();
    await expect(configView.locator("h2")).toContainText(
      "Configure virtual machine"
    );
  });

  test("step 2: shows all configuration options", async ({ page }) => {
    await navigateToUtmStep2(page);

    const configView = page.locator("utm-configure-view");

    // Check for all settings
    await expect(configView).toContainText("Display name");
    await expect(configView).toContainText("CPU cores");
    await expect(configView).toContainText("Memory");
    await expect(configView).toContainText("Disk size");
  });

  test("step 2: can modify VM name", async ({ page }) => {
    await navigateToUtmStep2(page);

    const configView = page.locator("utm-configure-view");
    const nameInput = configView.getByRole("textbox", { name: "Display name" });

    await nameInput.clear();
    await nameInput.fill("My Home Assistant VM");

    await expect(nameInput).toHaveValue("My Home Assistant VM");
  });

  test("step 2: keeps the configuration when stepping back to it", async ({
    page,
  }) => {
    await navigateToUtmStep2(page);

    const configView = page.locator("utm-configure-view");
    const nameInput = configView.getByRole("textbox", { name: "Display name" });
    const coresValue = configView.locator(".setting-value").first();

    const defaultCores = await coresValue.textContent();

    // Pick something other than the defaults
    await nameInput.clear();
    await nameInput.fill("My Home Assistant VM");

    const coresSlider = configView.getByRole("slider", {
      name: "CPU cores",
      exact: true,
    });
    await coresSlider.focus();
    await coresSlider.press("ArrowRight");

    const chosenCores = await coresValue.textContent();
    expect(chosenCores).not.toBe(defaultCores);

    // Forward to the confirmation step...
    await page
      .locator("wizard-shell")
      .locator(".footer-right wa-button")
      .click();
    await expect(page.locator("utm-confirm-view")).toBeVisible();
    await expect(page.locator("utm-confirm-view")).toContainText(
      "My Home Assistant VM"
    );

    // ...then back to double-check: the settings must still be the user's,
    // not silently reset to the defaults
    await page.locator("wizard-shell").locator(".back").click();
    await expect(configView).toBeVisible();
    await expect(
      configView.getByRole("textbox", { name: "Display name" })
    ).toHaveValue("My Home Assistant VM");
    await expect(coresValue).toHaveText(chosenCores!);

    // And forward again, so what gets installed is what was picked
    await page
      .locator("wizard-shell")
      .locator(".footer-right wa-button")
      .click();
    await expect(page.locator("utm-confirm-view")).toContainText(
      "My Home Assistant VM"
    );
  });

  test("step 2: shows CPU cores slider", async ({ page }) => {
    await navigateToUtmStep2(page);

    const configView = page.locator("utm-configure-view");

    // Should show CPU cores setting with value
    await expect(configView).toContainText("CPU cores");
    await expect(configView).toContainText("cores");
  });

  test("step 2: shows memory slider with GB value", async ({ page }) => {
    await navigateToUtmStep2(page);

    const configView = page.locator("utm-configure-view");

    // Should show memory in GB
    await expect(configView).toContainText("Memory");
    await expect(configView).toContainText("GB");
  });

  test("step 2: shows disk size slider", async ({ page }) => {
    await navigateToUtmStep2(page);

    const configView = page.locator("utm-configure-view");

    // Should show disk size
    await expect(configView).toContainText("Disk size");
  });

  test("step 2: shows configuration descriptions", async ({ page }) => {
    await navigateToUtmStep2(page);

    const configView = page.locator("utm-configure-view");

    // Should show helpful descriptions for settings
    const descriptions = configView.locator(".setting-description");
    await expect(descriptions.first()).toBeVisible();
  });

  test("step 2: next button is enabled", async ({ page }) => {
    await navigateToUtmStep2(page);

    const nextButton = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");
    await expect(nextButton).toHaveJSProperty("disabled", false);
  });

  test("step 2: can navigate to step 3", async ({ page }) => {
    await navigateToUtmStep2(page);

    const nextButton = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");
    await nextButton.click();

    // Should advance to confirmation
    await expect(page.locator("utm-confirm-view")).toBeVisible();
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

  test("step 2: can navigate back to step 1", async ({ page }) => {
    await navigateToUtmStep2(page);

    const backButton = page.locator("wizard-shell").locator(".back");
    await expect(backButton).toHaveJSProperty("disabled", false);
    await backButton.click();

    // Should go back to UTM check view
    await expect(page.locator("utm-check-view")).toBeVisible();
  });

  test("step 3: shows confirmation view", async ({ page }) => {
    await navigateToUtmStep3(page);

    const confirmView = page.locator("utm-confirm-view");
    await expect(confirmView).toBeVisible();
    await expect(confirmView.locator("h2")).toContainText("Ready");
  });

  test("step 3: shows configuration summary", async ({ page }) => {
    await navigateToUtmStep3(page);

    const confirmView = page.locator("utm-confirm-view");

    // Should show VM configuration details
    await expect(confirmView).toContainText("Virtual machine");
  });

  test("step 3: shows Install button instead of Next", async ({ page }) => {
    await navigateToUtmStep3(page);

    const installButton = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");
    await expect(installButton).toBeVisible();
    await expect(installButton).toContainText("Install");
  });

  test("step 3: clicking Install proceeds directly to installation", async ({
    page,
  }) => {
    await navigateToUtmStep3(page);

    // Click Install button - VM flow has no confirmation dialog
    const installButton = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");
    await installButton.click();

    // Should proceed directly to progress view (no dialog for VM flow)
    await expect(page.locator("utm-progress-view")).toBeVisible();
  });

  test("step 3: can navigate back to step 2", async ({ page }) => {
    await navigateToUtmStep3(page);

    const backButton = page.locator("wizard-shell").locator(".back");
    await expect(backButton).toHaveJSProperty("disabled", false);
    await backButton.click();

    // Should go back to configure view
    await expect(page.locator("utm-configure-view")).toBeVisible();
  });

  test("step 4: shows progress view during installation", async ({ page }) => {
    await navigateToUtmStep4(page);

    const progressView = page.locator("utm-progress-view");
    await expect(progressView).toBeVisible();
  });

  test("step 4: shows progress indicators", async ({ page }) => {
    await navigateToUtmStep4(page);

    const progressView = page.locator("utm-progress-view");

    // Should show progress bar
    await expect(progressView.locator("progress-bar")).toBeVisible();

    // Should show thinking cloud with stage
    await expect(progressView.locator(".thinking-cloud")).toBeVisible();
  });

  test("step 4: shows stage dots", async ({ page }) => {
    await navigateToUtmStep4(page);

    const progressView = page.locator("utm-progress-view");

    // Should have stage indicator
    await expect(progressView.locator(".stages-indicator")).toBeVisible();

    // Should show multiple stages
    const stageDots = progressView.locator(".stage-dot");
    await expect(stageDots.first()).toBeVisible();
  });

  test("step 4: offers only Cancel until the VM is being created", async ({
    page,
  }) => {
    await navigateToUtmStep4(page);

    const wizardShell = page.locator("wizard-shell");
    await expect(wizardShell.locator(".footer-left wa-button")).toHaveText(
      "Cancel"
    );
    await expect(wizardShell.locator(".footer-right wa-button")).toHaveCount(0);

    // Past this, the VM exists, and the install runs to the end. Cancel
    // goes, but the footer stays in place
    await expect(wizardShell.locator(".footer-left wa-button")).toBeHidden({
      timeout: 15000,
    });
    await expect(wizardShell.locator(".footer-left")).toBeVisible();
  });

  test("step 4: Cancel asks first, then stops before anything is created", async ({
    page,
  }) => {
    await navigateToUtmStep4(page);

    const wizardShell = page.locator("wizard-shell");
    const stopDialog = page.locator("app-shell > info-dialog.stop-dialog");
    await wizardShell.locator(".footer-left wa-button").click();
    await expect(stopDialog.getByText("nothing is left behind")).toBeVisible();
    await stopDialog.getByRole("button", { name: "Stop installation" }).click();

    await expect(page.locator("utm-progress-view .error-message")).toHaveText(
      "Installation stopped. No virtual machine was created in UTM."
    );
    await expect(wizardShell.locator(".footer-right wa-button")).toHaveText(
      "Try again"
    );
  });

  test("step 4: back button is hidden during installation", async ({
    page,
  }) => {
    await navigateToUtmStep4(page);

    const wizardShell = page.locator("wizard-shell");
    const backButton = wizardShell.locator(".back");
    await expect(backButton).toHaveCSS("visibility", "hidden");
  });

  test("step 4: advances to success after installation completes", async ({
    page,
  }) => {
    await navigateToUtmStep4(page);

    // Wait for installation to complete (mock should finish quickly)
    await expect(page.locator("utm-success-view")).toBeVisible({
      timeout: 30000,
    });
  });

  test("step 5: shows success view", async ({ page }) => {
    await navigateToUtmStep5(page);

    const successView = page.locator("utm-success-view");
    await expect(successView).toBeVisible();
    await expect(successView.locator("h2")).toContainText("all set");
  });

  test("step 5: shows Casita mascot", async ({ page }) => {
    await navigateToUtmStep5(page);

    const successView = page.locator("utm-success-view");
    await expect(successView.locator("casita-mascot")).toBeVisible();
  });

  test("step 5: shows next steps instructions", async ({ page }) => {
    await navigateToUtmStep5(page);

    const successView = page.locator("utm-success-view");

    // Should show next steps
    await expect(successView.locator(".next-steps")).toBeVisible();
  });

  test("step 5: shows UTM instructions", async ({ page }) => {
    await navigateToUtmStep5(page);

    const successView = page.locator("utm-success-view");

    // Should mention UTM in instructions - use toContainText which penetrates shadow DOM
    await expect(successView).toContainText("UTM");
  });

  test("step 5: shows Done button", async ({ page }) => {
    await navigateToUtmStep5(page);

    const wizardShell = page.locator("wizard-shell");
    const doneButton = wizardShell.locator(".footer-right wa-button");
    await expect(doneButton).toBeVisible();
    await expect(doneButton).toContainText("Done");
  });

  test("step 5: back button is hidden on success", async ({ page }) => {
    await navigateToUtmStep5(page);

    const wizardShell = page.locator("wizard-shell");
    const backButton = wizardShell.locator(".back");
    await expect(backButton).toHaveCSS("visibility", "hidden");
  });

  test("step 5: clicking Done returns to welcome", async ({ page }) => {
    await navigateToUtmStep5(page);

    const wizardShell = page.locator("wizard-shell");
    const doneButton = wizardShell.locator(".footer-right wa-button");
    await doneButton.click();

    // Should be back on welcome screen
    await expect(page.locator("welcome-view")).toBeVisible();
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

async function navigateToUtmStep4(page: Page) {
  await navigateToUtmStep3(page);
  // No confirmation dialog for VM flow - proceeds directly to install
  await page.locator("wizard-shell").locator(".footer-right wa-button").click();
  await expect(page.locator("utm-progress-view")).toBeVisible();
}

async function navigateToUtmStep5(page: Page) {
  await navigateToUtmStep4(page);
  await expect(page.locator("utm-success-view")).toBeVisible({
    timeout: 30000,
  });
}
