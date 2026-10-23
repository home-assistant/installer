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

  test("can navigate back through each step", async ({ page }) => {
    await navigateToProxmoxStep3(page);

    const backButton = page
      .locator("wizard-shell")
      .locator(".header wa-button");
    await expect(backButton).toHaveJSProperty("disabled", false);
    await backButton.click();

    // Should go back to configure view
    await expect(page.locator("proxmox-configure-view")).toBeVisible();

    await backButton.click();
    await expect(page.locator("proxmox-connect-view")).toBeVisible();
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
    await expect(page.locator("wizard-shell .header wa-button")).toHaveCSS(
      "visibility",
      "hidden"
    );

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
