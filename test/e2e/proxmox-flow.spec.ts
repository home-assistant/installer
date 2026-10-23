import { test, expect, type Page } from "@playwright/test";
import { approveProxmoxImport } from "./fixtures.js";

test.describe("Proxmox Installation Flow", () => {
  test.beforeEach(async ({ page }) => {
    // Use mock mode to avoid actual Proxmox connections
    await page.goto("/");
    await page.getByRole("button", { name: "Let's go" }).click();
    await expect(page.locator("path-selection-view")).toBeVisible();
    // Select Proxmox Server option
    await page.locator('option-card[heading="Proxmox server"]').click();
    await expect(page.locator("wizard-shell")).toBeVisible();
  });

  test("shows wizard shell with correct flow title", async ({ page }) => {
    const wizardShell = page.locator("wizard-shell");
    await expect(wizardShell).toContainText("Proxmox");
  });

  test("shows step indicator with all steps", async ({ page }) => {
    const stepIndicator = page.locator("step-indicator");
    await expect(stepIndicator).toBeVisible();
    // Should show: Connect to Proxmox, Configure VM, Confirm, Install, Done
    await expect(stepIndicator).toContainText("Connect to Proxmox");
    await expect(stepIndicator).toContainText("Configure VM");
    await expect(stepIndicator).toContainText("Confirm");
    await expect(stepIndicator).toContainText("Install");
    await expect(stepIndicator).toContainText("Done");
  });

  test("step 1: shows Proxmox connection view", async ({ page }) => {
    const connectView = page.locator("proxmox-connect-view");
    await expect(connectView).toBeVisible();
  });

  test("step 1: shows connection form fields", async ({ page }) => {
    const connectView = page.locator("proxmox-connect-view");

    // Check heading
    await expect(
      connectView.getByRole("heading", {
        name: "Connect to Proxmox VE",
        exact: true,
      })
    ).toBeVisible();

    // Check form fields
    await expect(connectView.locator("#server-url")).toBeVisible();
    await expect(connectView.locator("#username")).toBeVisible();
    await expect(connectView.locator("#password")).toBeVisible();

    // Check placeholders/hints
    await expect(connectView.locator("#server-url")).toHaveAttribute(
      "placeholder",
      "https://192.168.1.100:8006"
    );
    await expect(connectView.locator("#username")).toHaveAttribute(
      "placeholder",
      "root@pam"
    );
  });

  test("step 1: clicking next with empty form shows error", async ({
    page,
  }) => {
    const connectView = page.locator("proxmox-connect-view");
    const nextButton = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");

    // Clear the username field (which has default value)
    await connectView.locator("#username").clear();

    // Click next - should trigger validation
    await nextButton.click();

    // Should say on each empty field what is missing and stay on connect view
    await expect(connectView.locator("wa-input[custom-error]")).toHaveCount(3);
    await expect(connectView).toContainText("Enter the server URL");
    await expect(connectView).toContainText("Enter the username");
    await expect(connectView).toContainText("Enter the password");
    await expect(connectView.locator("#server-url")).toBeFocused();
    await expect(connectView.locator(".status-row")).toHaveCount(0);
    await expect(connectView).toBeVisible();
  });

  test("step 1: clicking next with invalid URL shows error", async ({
    page,
  }) => {
    const connectView = page.locator("proxmox-connect-view");

    // Fill with invalid URL (http instead of https)
    await connectView.locator("#server-url").fill("http://192.168.1.100:8006");
    await connectView.locator("#username").fill("root@pam");
    await connectView.locator("#password").fill("password123");

    const nextButton = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");

    // Click next - should trigger validation
    await nextButton.click();

    // Should say on the URL field that it needs HTTPS and stay on connect view
    const url = connectView.locator("#server-url");
    await expect(url).toBeFocused();
    await expect(url).toHaveAttribute("aria-invalid", "true");
    await expect(url).toHaveAccessibleDescription(/HTTPS/);
    await expect(connectView.locator(".status-row")).toHaveCount(0);
    await expect(connectView).toBeVisible();
  });

  test("step 1: can navigate to step 2 with valid connection", async ({
    page,
  }) => {
    const connectView = page.locator("proxmox-connect-view");

    // Fill with valid credentials for mock mode
    await connectView.locator("#server-url").fill("https://192.168.1.100:8006");
    await connectView.locator("#username").fill("root@pam");
    await connectView.locator("#password").fill("test");

    const nextButton = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");
    await expect(nextButton).toHaveJSProperty("disabled", false);
    await nextButton.click();

    // The browser mock accepts any HTTPS server with a password
    await expect(page.locator("proxmox-configure-view")).toBeVisible();
    await expect(connectView).toHaveCount(0);
  });

  test("step 2: shows VM configuration view", async ({ page }) => {
    // Navigate to step 2
    await navigateToProxmoxStep2(page);

    const configView = page.locator("proxmox-configure-view");
    await expect(configView).toBeVisible();
    await expect(configView.locator("h2")).toContainText(
      "Configure virtual machine"
    );
  });

  test("step 2: shows all configuration options", async ({ page }) => {
    await navigateToProxmoxStep2(page);

    const configView = page.locator("proxmox-configure-view");

    // Check for all settings
    await expect(configView).toContainText("Display name");
    await expect(configView).toContainText("Node");
    await expect(configView).toContainText("Storage");
    await expect(configView).toContainText("VM ID");
    await expect(configView).toContainText("CPU cores");
    await expect(configView).toContainText("Memory");
    await expect(configView).toContainText("Disk size");
  });

  test("step 2: can modify VM name", async ({ page }) => {
    await navigateToProxmoxStep2(page);

    const configView = page.locator("proxmox-configure-view");
    const nameInput = configView
      .getByRole("textbox", { name: "Display name" })
      .first();

    await nameInput.clear();
    await nameInput.fill("my-home-assistant");

    await expect(nameInput).toHaveValue("my-home-assistant");
  });

  test("step 2: can adjust CPU cores slider", async ({ page }) => {
    await navigateToProxmoxStep2(page);

    const configView = page.locator("proxmox-configure-view");

    // Should show CPU value
    await expect(configView).toContainText("cores");
  });

  test("step 2: can adjust memory slider", async ({ page }) => {
    await navigateToProxmoxStep2(page);

    const configView = page.locator("proxmox-configure-view");

    // Should show memory value in GB
    await expect(configView).toContainText("GB");
  });

  test("step 2: can navigate to step 3", async ({ page }) => {
    await navigateToProxmoxStep2(page);

    // Next should be enabled
    const nextButton = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");
    await expect(nextButton).toHaveJSProperty("disabled", false);
    await nextButton.click();

    // Should advance to confirmation
    await expect(page.locator("proxmox-confirm-view")).toBeVisible();
  });

  test("step 2: can navigate back to step 1", async ({ page }) => {
    await navigateToProxmoxStep2(page);

    const backButton = page
      .locator("wizard-shell")
      .locator(".header wa-button");
    await expect(backButton).toHaveJSProperty("disabled", false);
    await backButton.click();

    // Should go back to connection view
    await expect(page.locator("proxmox-connect-view")).toBeVisible();
  });

  test("step 2: keeps the configuration when stepping back to it", async ({
    page,
  }) => {
    await navigateToProxmoxStep2(page);

    const configView = page.locator("proxmox-configure-view");
    const nameInput = configView
      .getByRole("textbox", { name: "Display name" })
      .first();
    const coresValue = configView.locator(".setting-value").first();

    const defaultCores = await coresValue.textContent();

    // Pick something other than the defaults
    await nameInput.clear();
    await nameInput.fill("my-home-assistant");

    const coresSlider = configView.getByRole("slider", {
      name: "CPU cores",
      exact: true,
    });
    await coresSlider.focus();
    await coresSlider.press("ArrowRight");

    const chosenCores = await coresValue.textContent();
    expect(chosenCores).not.toBe(defaultCores);

    // Forward to the confirmation step...
    const nextButton = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");
    await expect(nextButton).toHaveJSProperty("disabled", false);
    await nextButton.click();
    await expect(page.locator("proxmox-confirm-view")).toBeVisible();
    await expect(page.locator("proxmox-confirm-view")).toContainText(
      "my-home-assistant"
    );

    // ...then back to double-check: the settings must still be the user's,
    // not silently reset to the defaults
    await page.locator("wizard-shell").locator(".header wa-button").click();
    await expect(configView).toBeVisible();
    await expect(
      configView.getByRole("textbox", { name: "Display name" }).first()
    ).toHaveValue("my-home-assistant");
    await expect(coresValue).toHaveText(chosenCores!);

    // And forward again, so what gets installed is what was picked
    await expect(nextButton).toHaveJSProperty("disabled", false);
    await nextButton.click();
    await expect(page.locator("proxmox-confirm-view")).toContainText(
      "my-home-assistant"
    );
  });

  test("step 3: shows confirmation view", async ({ page }) => {
    await navigateToProxmoxStep3(page);

    const confirmView = page.locator("proxmox-confirm-view");
    await expect(confirmView).toBeVisible();
    await expect(confirmView.locator("h2")).toContainText("Ready to install");
  });

  test("step 3: shows configuration summary", async ({ page }) => {
    await navigateToProxmoxStep3(page);

    const confirmView = page.locator("proxmox-confirm-view");

    // Should show VM details
    await expect(confirmView).toContainText("Virtual machine");
    await expect(confirmView).toContainText("Node");
    await expect(confirmView).toContainText("Storage");
  });

  test("step 3: shows Install button instead of Next", async ({ page }) => {
    await navigateToProxmoxStep3(page);

    const installButton = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");
    await expect(installButton).toBeVisible();
    await expect(installButton).toContainText("Install");
  });

  test("step 3: clicking Install proceeds directly to installation", async ({
    page,
  }) => {
    await navigateToProxmoxStep3(page);

    // Click Install button - Proxmox flow has no confirmation dialog
    const installButton = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");
    await installButton.click();

    // Should proceed directly to progress view (no dialog for Proxmox flow)
    await expect(page.locator("proxmox-progress-view")).toBeVisible();
  });

  test("step 3: can navigate back to step 2", async ({ page }) => {
    await navigateToProxmoxStep3(page);

    const backButton = page
      .locator("wizard-shell")
      .locator(".header wa-button");
    await expect(backButton).toHaveJSProperty("disabled", false);
    await backButton.click();

    // Should go back to configure view
    await expect(page.locator("proxmox-configure-view")).toBeVisible();
  });

  test("step 4: shows progress view during installation", async ({ page }) => {
    await navigateToProxmoxStep4(page);

    const progressView = page.locator("proxmox-progress-view");
    await expect(progressView).toBeVisible();
  });

  test("step 4: shows progress indicators", async ({ page }) => {
    await navigateToProxmoxStep4(page);

    const progressView = page.locator("proxmox-progress-view");

    // Should show progress bar
    await expect(progressView.locator("progress-bar")).toBeVisible();

    // Should show thinking cloud with stage
    await expect(progressView.locator(".thinking-cloud")).toBeVisible();
  });

  test("step 4: shows stage dots", async ({ page }) => {
    await navigateToProxmoxStep4(page);

    const progressView = page.locator("proxmox-progress-view");

    // Should have stage indicator
    await expect(progressView.locator(".stages-indicator")).toBeVisible();

    // Should show multiple stages
    const stageDots = progressView.locator(".stage-dot");
    await expect(stageDots.first()).toBeVisible();
  });

  test("step 4: offers only Cancel until the VM is being created", async ({
    page,
  }) => {
    await navigateToProxmoxStep4(page);

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
    await navigateToProxmoxStep4(page);

    const wizardShell = page.locator("wizard-shell");
    const stopDialog = page.locator("app-shell > info-dialog.stop-dialog");
    await wizardShell.locator(".footer-left wa-button").click();
    await expect(stopDialog.getByText("nothing is left behind")).toBeVisible();
    await stopDialog.getByRole("button", { name: "Stop installation" }).click();

    await expect(
      page.locator("proxmox-progress-view .error-message")
    ).toHaveText("Installation stopped. Nothing was created on Proxmox.");
    await expect(wizardShell.locator(".footer-right wa-button")).toHaveText(
      "Try again"
    );
  });

  test("step 4: back button is hidden during installation", async ({
    page,
  }) => {
    await navigateToProxmoxStep4(page);

    const wizardShell = page.locator("wizard-shell");
    const backButton = wizardShell.locator(".header wa-button");
    await expect(backButton).toHaveCSS("visibility", "hidden");
  });

  test("step 4: advances to success after installation completes", async ({
    page,
  }) => {
    await navigateToProxmoxStep4(page);

    // Wait for installation to complete (mock should finish quickly)
    await expect(page.locator("proxmox-success-view")).toBeVisible({
      timeout: 30000,
    });
  });

  test("step 5: shows success view", async ({ page }) => {
    await navigateToProxmoxStep5(page);

    const successView = page.locator("proxmox-success-view");
    await expect(successView).toBeVisible();
    await expect(successView.locator("h2")).toContainText("all set");
  });

  test("step 5: shows Casita mascot", async ({ page }) => {
    await navigateToProxmoxStep5(page);

    const successView = page.locator("proxmox-success-view");
    await expect(successView.locator("casita-mascot")).toBeVisible();
  });

  test("step 5: shows VM access information", async ({ page }) => {
    await navigateToProxmoxStep5(page);

    const successView = page.locator("proxmox-success-view");

    // Should show next steps
    await expect(successView.locator(".next-steps")).toBeVisible();
  });

  test("step 5: shows Done button", async ({ page }) => {
    await navigateToProxmoxStep5(page);

    const wizardShell = page.locator("wizard-shell");
    const doneButton = wizardShell.locator(".footer-right wa-button");
    await expect(doneButton).toBeVisible();
    await expect(doneButton).toContainText("Done");
  });

  test("step 5: back button is hidden on success", async ({ page }) => {
    await navigateToProxmoxStep5(page);

    const wizardShell = page.locator("wizard-shell");
    const backButton = wizardShell.locator(".header wa-button");
    await expect(backButton).toHaveCSS("visibility", "hidden");
  });

  test("step 5: clicking Done returns to welcome", async ({ page }) => {
    await navigateToProxmoxStep5(page);

    const wizardShell = page.locator("wizard-shell");
    const doneButton = wizardShell.locator(".footer-right wa-button");
    await doneButton.click();

    // Should be back on welcome screen
    await expect(page.locator("welcome-view")).toBeVisible();
  });

  test("can cancel wizard at any step before installation", async ({
    page,
  }) => {
    // Test cancel on step 1
    const wizardShell = page.locator("wizard-shell");
    await wizardShell.locator(".footer-left wa-button").click();
    await expect(page.locator("welcome-view")).toBeVisible();

    // Restart and test cancel on step 2
    await page.getByRole("button", { name: "Let's go" }).click();
    await page.locator('option-card[heading="Proxmox server"]').click();
    await navigateToProxmoxStep2(page);
    await wizardShell.locator(".footer-left wa-button").click();
    await expect(page.locator("welcome-view")).toBeVisible();
  });

  test("complete end-to-end flow", async ({ page }) => {
    // Step 1: Connect
    const connectView = page.locator("proxmox-connect-view");
    await expect(connectView).toBeVisible();

    await connectView.locator("#server-url").fill("https://192.168.1.100:8006");
    await connectView.locator("#username").fill("root@pam");
    await connectView.locator("#password").fill("test");

    await page
      .locator("wizard-shell")
      .locator(".footer-right wa-button")
      .click();

    // Step 2: Configure (wait for Next to enable once node/storage defaults load)
    await expect(page.locator("proxmox-configure-view")).toBeVisible();
    await approveProxmoxImport(page);
    const configNext = page
      .locator("wizard-shell")
      .locator(".footer-right wa-button");
    await expect(configNext).toHaveJSProperty("disabled", false);
    await configNext.click();

    // Step 3: Confirm - click Install (no confirmation dialog for Proxmox)
    await expect(page.locator("proxmox-confirm-view")).toBeVisible();
    await page
      .locator("wizard-shell")
      .locator(".footer-right wa-button")
      .click();

    // Step 4: Progress (proceeds directly, no dialog)
    await expect(page.locator("proxmox-progress-view")).toBeVisible();

    // Step 5: Success
    await expect(page.locator("proxmox-success-view")).toBeVisible({
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
async function navigateToProxmoxStep2(page: Page) {
  const connectView = page.locator("proxmox-connect-view");
  await connectView.locator("#server-url").fill("https://192.168.1.100:8006");
  await connectView.locator("#username").fill("root@pam");
  await connectView.locator("#password").fill("test");
  await page.locator("wizard-shell").locator(".footer-right wa-button").click();
  await expect(page.locator("proxmox-configure-view")).toBeVisible();
  await approveProxmoxImport(page);
}

async function navigateToProxmoxStep3(page: Page) {
  await navigateToProxmoxStep2(page);
  // Node/storage defaults load async, so Next stays disabled briefly. Playwright
  // can't detect a wa-button's disabled state, so wait for it explicitly before
  // clicking (otherwise the click lands on a still-disabled button and is a no-op).
  const nextButton = page
    .locator("wizard-shell")
    .locator(".footer-right wa-button");
  await expect(nextButton).toHaveJSProperty("disabled", false);
  await nextButton.click();
  await expect(page.locator("proxmox-confirm-view")).toBeVisible();
}

async function navigateToProxmoxStep4(page: Page) {
  await navigateToProxmoxStep3(page);
  // No confirmation dialog for Proxmox flow - proceeds directly to install
  await page.locator("wizard-shell").locator(".footer-right wa-button").click();
  await expect(page.locator("proxmox-progress-view")).toBeVisible();
}

async function navigateToProxmoxStep5(page: Page) {
  await navigateToProxmoxStep4(page);
  await expect(page.locator("proxmox-success-view")).toBeVisible({
    timeout: 30000,
  });
}
