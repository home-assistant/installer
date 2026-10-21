import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { approveProxmoxImport } from "./fixtures.js";

// Every screen of every flow, checked against WCAG 2.1 A and AA plus axe's
// best practices. A screen reader still has to be tried by hand: this catches
// missing names, roles, values and landmarks, not how things sound.

async function expectAccessible(page: Page, screen: string) {
  // Retried, because a dialog is measured as see-through while it opens.
  // A real problem stays and still fails.
  await expect(async () => {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
      // Comes from inside Web Awesome's wa-select, which names its input
      // with a title only. The select itself is labelled, so it is
      // announced fine.
      .disableRules(["label-title-only"])
      .analyze();
    const violations = results.violations.map(
      (violation) =>
        `${violation.id}: ${violation.nodes
          .map((node) => node.target.join(" "))
          .join(", ")}`
    );
    expect(violations, screen).toEqual([]);
  }).toPass({ timeout: 5000 });
}

const next = (page: Page) =>
  page.getByRole("button", { name: "Next", exact: true });

async function start(page: Page, option: string) {
  await page.goto("/");
  await expect(page.locator("welcome-view h1")).toBeVisible();
  await expectAccessible(page, "welcome");
  await page.locator("welcome-view wa-button").click();
  await expect(page.locator("path-selection-view")).toBeVisible();
  await expectAccessible(page, "path selection");
  await page.locator(`option-card[title="${option}"]`).click();
}

async function writeToFirstDrive(page: Page) {
  await expect(
    page.locator("drive-selection-view drive-card").first()
  ).toBeVisible();
  await expectAccessible(page, "drive selection");
  await page.locator("drive-selection-view drive-card").first().click();
  await next(page).click();

  await expect(page.locator("confirmation-view")).toBeVisible();
  await expectAccessible(page, "confirmation");
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect(
    page.locator("confirm-dialog wa-button[variant='danger']")
  ).toBeVisible();
  await expectAccessible(page, "erase confirmation");
  await page.locator("confirm-dialog wa-button[variant='danger']").click();

  await expect(page.locator("progress-view")).toBeVisible();
  await expectAccessible(page, "progress");
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test("other installation options", async ({ page }) => {
      await start(page, "Others");
      await expect(page.locator("other-options-view")).toBeVisible();
      await expectAccessible(page, "other options");
    });

    test("board flow", async ({ page }) => {
      test.setTimeout(60000);
      await start(page, "Raspberry Pi & other boards");
      await expect(page.locator("device-selection-view")).toBeVisible();
      await expectAccessible(page, "device selection");
      await page
        .getByRole("radio", { name: "Raspberry Pi 5", exact: true })
        .click();
      await next(page).click();
      await writeToFirstDrive(page);
      await expect(page.locator("success-view")).toBeVisible({
        timeout: 45000,
      });
      await expectAccessible(page, "success");
    });

    test("Home Assistant hardware flow", async ({ page }) => {
      test.setTimeout(60000);
      await start(page, "Home Assistant hardware");
      await expect(
        page.locator("ha-hardware-device-selection-view")
      ).toBeVisible();
      await expectAccessible(page, "device selection");
      await page.locator('device-card[value="ha-green"]').click();
      await next(page).click();
      await writeToFirstDrive(page);
      await expect(page.locator("ha-hardware-success-view")).toBeVisible({
        timeout: 45000,
      });
      await expectAccessible(page, "success");
    });

    test("mini PC flow", async ({ page }) => {
      test.setTimeout(60000);
      await start(page, "Generic (mini) PC");
      await expect(page.locator("minipc-setup-method-view")).toBeVisible();
      await expectAccessible(page, "setup method");
      await page
        .getByRole("button", { name: "I can connect the drive" })
        .click();
      await expect(
        page.locator("minipc-architecture-selection-view")
      ).toBeVisible();
      await expectAccessible(page, "architecture");
      await page.getByRole("radio", { name: "Intel/AMD" }).click();
      await next(page).click();
      await writeToFirstDrive(page);
      await expect(page.locator("success-view")).toBeVisible({
        timeout: 45000,
      });
      await expectAccessible(page, "success");
    });

    test("Proxmox flow", async ({ page }) => {
      test.setTimeout(60000);
      await start(page, "Proxmox server");
      await expect(page.locator("proxmox-connect-view")).toBeVisible();
      await expectAccessible(page, "connect");
      await page
        .getByLabel("Server URL", { exact: true })
        .fill("https://pve.test:8006");
      await page.getByLabel("Username", { exact: true }).fill("root@pam");
      await page.getByLabel("Password", { exact: true }).fill("test-password");
      await next(page).click();

      await expect(page.locator("proxmox-configure-view")).toBeVisible();
      await approveProxmoxImport(page);
      await expectAccessible(page, "configure");
      await next(page).click();

      await expect(page.locator("proxmox-confirm-view")).toBeVisible();
      await expectAccessible(page, "confirm");
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await expect(page.locator("proxmox-progress-view")).toBeVisible();
      await expectAccessible(page, "progress");
      await expect(page.locator("proxmox-success-view")).toBeVisible({
        timeout: 45000,
      });
      await expectAccessible(page, "success");
    });

    test("virtual machine flow", async ({ page }) => {
      test.setTimeout(60000);
      await page.addInitScript(() =>
        Object.defineProperty(navigator, "userAgent", {
          value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        })
      );
      await start(page, "Virtual machine");
      await expect(
        page.locator("utm-check-view casita-mascot")
      ).toHaveAttribute("mood", "happy");
      await expectAccessible(page, "check");
      await next(page).click();

      await expect(page.locator("utm-configure-view")).toBeVisible();
      await expectAccessible(page, "configure");
      await next(page).click();

      await expect(page.locator("utm-confirm-view")).toBeVisible();
      await expectAccessible(page, "confirm");
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await expect(page.locator("utm-progress-view")).toBeVisible();
      await expectAccessible(page, "progress");
      await expect(page.locator("utm-success-view")).toBeVisible({
        timeout: 45000,
      });
      await expectAccessible(page, "success");
    });
  });
}
