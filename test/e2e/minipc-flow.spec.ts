import { test, expect } from "./fixtures.js";

// Mini PC flow order: method → architecture → drive → confirm → flash → success

test.describe("Mini PC Flow - Setup Method Selection", () => {
  test.beforeEach(async ({ page }) => {
    // Use mock mode to avoid real API calls
    await page.goto("/");
    // Navigate to path selection
    await page.getByRole("button", { name: "Let's go" }).click();
    await expect(page.locator("path-selection-view")).toBeVisible();
  });

  test("each media type shows its own steps", async ({ page }) => {
    await page
      .locator('option-card[heading="Mini PC or other computer"]')
      .click();

    await page
      .locator("minipc-setup-method-view")
      .locator("option-card")
      .filter({ hasText: "ISO file" })
      .click();
    const steps = page.locator("step-indicator");
    await expect(steps).toContainText("Save location");
    await expect(steps).not.toContainText("Select USB stick");

    await page.getByRole("button", { name: "Back", exact: false }).click();
    await page
      .locator("minipc-setup-method-view")
      .locator("option-card")
      .filter({ hasText: "USB stick" })
      .click();
    await expect(steps).toContainText("Select USB stick");
    await expect(steps).not.toContainText("Save location");
  });
});

test.describe("Mini PC Flow - Architecture Selection", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Let's go" }).click();
    await page
      .locator('option-card[heading="Mini PC or other computer"]')
      .click();

    // Select "connect drive" to get to architecture selection
    const setupView = page.locator("minipc-setup-method-view");
    await expect(setupView).toBeVisible();
    const connectDriveOption = setupView
      .locator("option-card")
      .filter({ hasText: "Write the mini PC's drive here" });
    await connectDriveOption.click();
  });

  test("after visiting the USB stick path, the architecture must be picked again", async ({
    page,
  }) => {
    const archView = page.locator("minipc-architecture-selection-view");
    await archView
      .locator("option-card")
      .filter({ hasText: "Intel/AMD" })
      .click();
    await expect(page.locator("drive-selection-view")).toBeVisible();
    const back = page.getByRole("button", { name: "Back", exact: false });
    await back.click();
    await expect(archView).toBeVisible();
    await back.click();

    const setupView = page.locator("minipc-setup-method-view");
    await setupView
      .locator("option-card")
      .filter({ hasText: "USB stick" })
      .click();
    await expect(page.locator("drive-selection-view")).toBeVisible();
    await back.click();

    await setupView
      .locator("option-card")
      .filter({ hasText: "Write the mini PC's drive here" })
      .click();
    await expect(archView).toBeVisible();
    const picked = await page.evaluate(async () => {
      const state = "/src/state/wizard-state.ts";
      const { wizardState } = (await import(
        state
      )) as typeof import("../../src/state/wizard-state.js");
      return wizardState.getState().selections.device ?? null;
    });
    expect(picked).toBeNull();
  });

  test("offers the same restart as administrator as the USB stick path", async ({
    page,
  }) => {
    // Set before the scan; the step loads it once
    await page.evaluate(() =>
      sessionStorage.setItem("hai:mock-failure", "drives-admin")
    );
    await page
      .locator("minipc-architecture-selection-view")
      .locator("option-card")
      .filter({ hasText: "Intel/AMD" })
      .click();

    const drives = page.locator("drive-selection-view");
    await expect(drives).toContainText("needs administrator access");
    await expect(
      drives.getByRole("button", { name: "Restart as administrator" })
    ).toBeVisible();
    await expect(drives.locator("drive-card")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Next", exact: true })
    ).toBeDisabled();
  });

  test("opens on the drive step again after restarting as administrator", async ({
    page,
  }) => {
    await page.evaluate(() =>
      sessionStorage.setItem("hai:mock-failure", "drives-admin")
    );
    await page
      .locator("minipc-architecture-selection-view")
      .locator("option-card")
      .filter({ hasText: "Intel/AMD" })
      .click();
    await page
      .locator("drive-selection-view")
      .getByRole("button", { name: "Restart as administrator" })
      .click();

    // The browser mock's restart is a reload, with the state handed on
    await page.reload();

    const drives = page.locator("drive-selection-view");
    await expect(drives).toBeVisible();
    await expect(page.locator("welcome-view")).toHaveCount(0);
    await expect(drives.locator("drive-card").first()).toBeVisible();
    await expect(page.locator("step-indicator")).toContainText("Select drive");

    // The architecture picked before the restart is still picked
    await page.getByRole("button", { name: "Back", exact: false }).click();
    await expect(
      page
        .locator("minipc-architecture-selection-view")
        .locator("option-card")
        .filter({ hasText: "Intel/AMD" })
    ).toBeVisible();
    const device = await page.evaluate(async () => {
      const state = "/src/state/wizard-state.ts";
      const { wizardState } = (await import(
        state
      )) as typeof import("../../src/state/wizard-state.js");
      return wizardState.getState().selections.device ?? null;
    });
    expect(device).toBe("generic-x86-64");
  });
});
