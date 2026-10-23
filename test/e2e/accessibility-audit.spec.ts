import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import type { NodeResult } from "axe-core";
import { approveProxmoxImport, expect, test } from "./fixtures.js";

// Every screen of every flow, with its dialogs and error states, checked
// against WCAG 2.1 A and AA plus axe's best practices. A screen reader still
// has to be tried by hand: this catches missing names, roles, values and
// landmarks, not how things sound.

/**
 * Web Awesome's wa-select shows the choice in an input named only by its
 * title. The select itself is named by its label, so it is announced fine;
 * any other input named that way still fails.
 */
function insideSelect(rule: string, node: NodeResult) {
  // Each step down the chain is a selector in the shadow root above it
  const chain = node.target.flat();
  return (
    rule === "label-title-only" &&
    /^wa-select\b/.test(chain[chain.length - 2] ?? "")
  );
}

/**
 * Checks the page while `screen` shows. Retried, because a dialog is measured
 * as see-through while it opens; a real problem stays and still fails. The
 * screen has to show still once axe is done, so a step that moved on in the
 * meantime can't pass in its place.
 */
async function expectAccessible(page: Page, screen: Locator, name: string) {
  await expect(screen, name).toBeVisible();
  await expect(async () => {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
      .analyze();
    const violations = results.violations.flatMap(({ id, nodes }) => {
      const targets = nodes
        .filter((node) => !insideSelect(id, node))
        .map((node) => node.target.flat().join(" > "));
      return targets.length ? [`${id}: ${targets.join(", ")}`] : [];
    });
    expect(violations, name).toEqual([]);
    expect(await screen.isVisible(), `${name} still shows`).toBe(true);
  }).toPass({ timeout: 5000 });
}

const next = (page: Page, name = "Next") =>
  page.getByRole("button", { name, exact: true });

/** The open dialog of the dialog element `host`. */
const dialog = (page: Page, host: string) =>
  page.locator(host).getByRole("dialog");

async function start(page: Page, path: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.locator(`option-card[heading="${path}"]`).click();
}

/**
 * Listen for the backend holding back closing the app, as the desktop app
 * does, and return how to send that. The mock has no such event, so the
 * shell starts listening again through a stand-in for Tauri's IPC.
 */
async function catchCloseBlocked(page: Page) {
  await page.evaluate(() => {
    const testWindow = window as unknown as Record<string, unknown>;
    testWindow.isTauri = true;
    testWindow.__TAURI_INTERNALS__ = {
      transformCallback: (callback: () => void) => {
        testWindow.closeBlocked = callback;
        return 1;
      },
      invoke: async () => 1,
    };
    const shell = document.querySelector("app-shell")!;
    const parent = shell.parentElement!;
    shell.remove();
    parent.append(shell);
  });
  await expect
    .poll(() => page.evaluate(() => "closeBlocked" in window))
    .toBe(true);
  // Everything else goes to the mock again
  await page.evaluate(() => {
    delete (window as unknown as Record<string, unknown>).isTauri;
  });
  return () =>
    page.evaluate(() =>
      (window as unknown as { closeBlocked: () => void }).closeBlocked()
    );
}

/** From the drive step to the start of the write, checking each screen. */
async function startWrite(page: Page) {
  const drives = page.locator("drive-selection-view");
  await expect(drives.locator("drive-card").first()).toBeVisible();
  await expectAccessible(page, drives, "drive selection");
  await drives.locator("drive-card").first().click();
  await next(page).click();

  // Boards with built-in Wi-Fi ask for it first
  await expect(
    page.locator("wifi-view, confirmation-view").first()
  ).toBeVisible();
  if ((await page.locator("wifi-view").count()) > 0) {
    await expectAccessible(page, page.locator("wifi-view"), "Wi-Fi");
    await next(page).click();
  }

  await expectAccessible(
    page,
    page.locator("confirmation-view"),
    "confirmation"
  );
  await next(page, "Install").click();
  await expectAccessible(
    page,
    dialog(page, "confirm-dialog"),
    "erase confirmation"
  );
  await page
    .getByRole("button", { name: "Erase and install", exact: true })
    .click();
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test("the screens before a flow", async ({ page }) => {
      await page.goto("/");
      await expectAccessible(page, page.locator("welcome-view"), "welcome");
      await page.getByRole("button", { name: "Let's go" }).click();
      await expectAccessible(
        page,
        page.locator("path-selection-view"),
        "path selection"
      );
      await page.locator('option-card[heading="Other options"]').click();
      await expectAccessible(
        page,
        page.locator("other-options-view"),
        "other options"
      );
    });

    test("the connection check, while it checks and when it fails", async ({
      page,
    }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Let's go" }).click();
      // Held until the test fails it
      await page.evaluate(() => {
        const testWindow = window as unknown as Record<string, unknown>;
        testWindow.isTauri = true;
        testWindow.__TAURI_INTERNALS__ = {
          invoke: () =>
            new Promise((_, reject) => {
              testWindow.failConnection = () =>
                reject({
                  code: "network",
                  message: "Cannot reach version.home-assistant.io.",
                  retryable: true,
                  details: {},
                });
            }),
        };
      });
      await page
        .locator('option-card[heading="Raspberry Pi & other boards"]')
        .click();
      const check = page.locator("connection-check-view");
      await expect(
        check.getByRole("heading", { name: "Checking connection" })
      ).toBeVisible();
      await expectAccessible(page, check, "checking the connection");

      await page.evaluate(() =>
        (window as unknown as { failConnection: () => void }).failConnection()
      );
      await expect(
        check.getByRole("heading", { name: "Unable to connect" })
      ).toBeVisible();
      await expectAccessible(page, check, "unable to connect");

      // Through to the flow once it connects
      await page.evaluate(() => {
        delete (window as unknown as Record<string, unknown>).isTauri;
      });
      await check.getByRole("button", { name: "Try again" }).click();
      await expect(page.locator("device-selection-view")).toBeVisible();
    });

    test("board flow, with the stop and quit questions", async ({ page }) => {
      test.setTimeout(60000);
      await page.goto("/");
      const blockClose = await catchCloseBlocked(page);
      await page.getByRole("button", { name: "Let's go" }).click();
      await page
        .locator('option-card[heading="Raspberry Pi & other boards"]')
        .click();
      await expectAccessible(
        page,
        page.locator("device-selection-view"),
        "device selection"
      );
      await page
        .getByRole("radio", { name: "Raspberry Pi 5", exact: true })
        .click();
      await next(page).click();
      await startWrite(page);

      const progress = page.locator("progress-view");
      await expectAccessible(page, progress, "progress");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expectAccessible(
        page,
        dialog(page, "info-dialog.stop-dialog"),
        "stop question"
      );
      await page
        .getByRole("button", { name: "Keep installing", exact: true })
        .click();
      await expect(dialog(page, "info-dialog.stop-dialog")).toHaveCount(0);
      await blockClose();
      await expectAccessible(
        page,
        dialog(page, "info-dialog.quit-dialog"),
        "quit question"
      );
      await page
        .getByRole("button", { name: "Keep installing", exact: true })
        .click();

      await expect(page.locator("success-view")).toBeVisible({
        timeout: 45000,
      });
      await expectAccessible(page, page.locator("success-view"), "success");
    });

    test("a write that fails", async ({ page }) => {
      test.setTimeout(60000);
      await page.addInitScript(() => {
        sessionStorage.setItem("hai:mock-failure", "flash-write");
      });
      await start(page, "Raspberry Pi & other boards");
      await page
        .getByRole("radio", { name: "Raspberry Pi 5", exact: true })
        .click();
      await next(page).click();
      await startWrite(page);
      const progress = page.locator("progress-view");
      await expect(progress.getByRole("alert")).toContainText(
        "The drive is in use",
        { timeout: 30000 }
      );
      await expectAccessible(page, progress, "write error");
    });

    test("Home Assistant hardware flow", async ({ page }) => {
      test.setTimeout(60000);
      await start(page, "Home Assistant hardware");
      const devices = page.locator("ha-hardware-device-selection-view");
      await expect(devices.locator("device-card").first()).toBeVisible();
      await expectAccessible(page, devices, "device selection");
      await devices.locator('device-card[value="ha-green"]').click();
      await next(page).click();
      const reinstall = devices.locator("info-dialog");
      await expectAccessible(
        page,
        reinstall.getByRole("dialog"),
        "reinstall notice"
      );
      await reinstall
        .getByRole("button", { name: /^(Reinstall|Install)$/ })
        .click();
      await startWrite(page);
      await expectAccessible(page, page.locator("progress-view"), "progress");
      await expect(page.locator("ha-hardware-success-view")).toBeVisible({
        timeout: 45000,
      });
      await expectAccessible(
        page,
        page.locator("ha-hardware-success-view"),
        "success"
      );
    });

    test("the Yellow's compute module", async ({ page }) => {
      await start(page, "Home Assistant hardware");
      const devices = page.locator("ha-hardware-device-selection-view");
      await devices.locator('device-card[value="ha-yellow"]').click();
      await next(page).click();
      await devices
        .locator("info-dialog")
        .getByRole("button", { name: /^(Reinstall|Install)$/ })
        .click();
      await expectAccessible(
        page,
        page.locator("ha-hardware-module-selection-view"),
        "compute module"
      );
    });

    test("mini PC flow", async ({ page }) => {
      test.setTimeout(60000);
      await start(page, "Mini PC or other computer");
      const method = page.locator("minipc-setup-method-view");
      await expectAccessible(page, method, "setup method");
      await method
        .locator("option-card")
        .filter({ hasText: "I can connect the drive" })
        .click();
      await expectAccessible(
        page,
        page.locator("minipc-architecture-selection-view"),
        "processor"
      );
      await page.getByRole("radio", { name: "Intel/AMD" }).click();
      await next(page).click();
      await startWrite(page);
      await expectAccessible(page, page.locator("progress-view"), "progress");
      await expect(page.locator("success-view")).toBeVisible({
        timeout: 45000,
      });
      await expectAccessible(page, page.locator("success-view"), "success");
    });

    for (const media of ["USB stick", "ISO file"] as const) {
      test(`mini PC booting from a ${media}`, async ({ page }) => {
        test.setTimeout(60000);
        await start(page, "Mini PC or other computer");
        await page
          .locator("minipc-setup-method-view option-card")
          .filter({ hasText: "I need to boot from USB" })
          .click();
        const mediaView = page.locator("minipc-media-view");
        await expectAccessible(page, mediaView, "bootable media");
        await mediaView
          .locator("option-card")
          .filter({ hasText: media })
          .click();

        if (media === "USB stick") {
          const drives = page.locator("live-usb-gate drive-selection-view");
          await expect(drives.getByRole("radio").first()).toBeVisible();
          await expectAccessible(page, drives, "USB stick");
          await drives.getByRole("radio").first().click();
        } else {
          await expectAccessible(
            page,
            page.locator("live-iso-location-view"),
            "ISO location"
          );
        }
        await next(page).click();

        await expectAccessible(
          page,
          page.locator("live-usb-summary-view"),
          "summary"
        );
        await next(page, "Create").click();
        if (media === "USB stick") {
          await expectAccessible(
            page,
            dialog(page, "confirm-dialog"),
            "erase confirmation"
          );
          await page
            .getByRole("button", { name: "Erase and install", exact: true })
            .click();
          await expectAccessible(
            page,
            page.locator("live-usb-progress-view"),
            "progress"
          );
        }
        const success = page.locator("live-usb-success-view");
        await expect(success).toBeVisible({ timeout: 30000 });
        await expectAccessible(page, success, "success");
      });
    }

    test("Proxmox flow", async ({ page }) => {
      test.setTimeout(60000);
      await start(page, "Proxmox server");
      await expectAccessible(
        page,
        page.locator("proxmox-connect-view"),
        "connect"
      );
      await page
        .getByLabel("Server URL", { exact: true })
        .fill("https://pve.test:8006");
      await page.getByLabel("Username", { exact: true }).fill("root@pam");
      await page.getByLabel("Password", { exact: true }).fill("test-password");
      await next(page).click();

      const configure = page.locator("proxmox-configure-view");
      await expect(configure).toBeVisible();
      await approveProxmoxImport(page);
      await expectAccessible(page, configure, "configure");
      await next(page).click();

      await expectAccessible(
        page,
        page.locator("proxmox-confirm-view"),
        "confirm"
      );
      await next(page, "Install").click();
      await expectAccessible(
        page,
        page.locator("proxmox-progress-view"),
        "progress"
      );
      await expect(page.locator("proxmox-success-view")).toBeVisible({
        timeout: 45000,
      });
      await expectAccessible(
        page,
        page.locator("proxmox-success-view"),
        "success"
      );
    });

    test.describe("on a Mac", () => {
      test.use({ platform: "macos" });

      test("virtual machine flow", async ({ page }) => {
        test.setTimeout(60000);
        await start(page, "Virtual machine");
        await expect(
          page.locator("utm-check-view casita-mascot")
        ).toHaveAttribute("mood", "happy");
        await expectAccessible(page, page.locator("utm-check-view"), "check");
        await next(page).click();

        await expectAccessible(
          page,
          page.locator("utm-configure-view"),
          "configure"
        );
        await next(page).click();

        await expectAccessible(
          page,
          page.locator("utm-confirm-view"),
          "confirm"
        );
        await next(page, "Install").click();
        await expectAccessible(
          page,
          page.locator("utm-progress-view"),
          "progress"
        );
        await expect(page.locator("utm-success-view")).toBeVisible({
          timeout: 45000,
        });
        await expectAccessible(
          page,
          page.locator("utm-success-view"),
          "success"
        );
      });

      test("a virtual machine that fails to install", async ({ page }) => {
        test.setTimeout(60000);
        await page.addInitScript(() => {
          sessionStorage.setItem("hai:mock-failure", "utm-create");
        });
        await start(page, "Virtual machine");
        await expect(
          page.locator("utm-check-view casita-mascot")
        ).toHaveAttribute("mood", "happy");
        await next(page).click();
        await expect(page.locator("utm-configure-view")).toBeVisible();
        await next(page).click();
        await expect(page.locator("utm-confirm-view")).toBeVisible();
        await next(page, "Install").click();
        const progress = page.locator("utm-progress-view");
        await expect(progress.locator(".error-message")).toBeVisible({
          timeout: 30000,
        });
        await expectAccessible(page, progress, "install error");
      });
    });
  });
}
