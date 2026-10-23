import type { Page } from "@playwright/test";
import { expect, skipWifiStep, test } from "./fixtures.js";

// A dialog leaves the rest of the page inert while it is open, and gives the
// focus back to what opened it as it closes. When the screen changes under
// the dialog, that is gone, and the focus fell to the page.

const cancel = (page: Page) =>
  page.getByRole("button", { name: "Cancel", exact: true });

/** Start writing a drive for a Raspberry Pi 5, the flash taking ~15s. */
async function startFlash(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .getByRole("button", { name: "Raspberry Pi & other boards" })
    .click();
  await page
    .getByRole("button", { name: "Raspberry Pi 5", exact: true })
    .click();
  await page.getByRole("radio").first().click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await skipWifiStep(page);
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await page
    .getByRole("button", { name: "Erase and install", exact: true })
    .click();
  // The question animates out first, its own Cancel with it
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(cancel(page)).toBeVisible();
}

/** Ask to stop, and leave the question open. */
async function askToStop(page: Page) {
  await cancel(page).click();
  await expect(
    page.getByRole("dialog", { name: "Stop the installation?" })
  ).toBeVisible();
}

/** Whether the focus stays off the page once the dialog's timers ran. */
async function focusOnPage(page: Page) {
  return page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return document.activeElement === document.body;
  });
}

test("a flash that ends while asking to stop continues from the success", async ({
  page,
}) => {
  test.setTimeout(60000);
  await startFlash(page);
  await askToStop(page);

  // The flash finishes meanwhile, and Cancel goes with the step
  const heading = page
    .locator("success-view")
    .getByRole("heading", { name: "You're all set!" });
  await expect(heading).toBeFocused({ timeout: 30000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await focusOnPage(page)).toBe(false);
  await expect(heading).toBeFocused();
});

test("a flash that fails while asking to stop continues from the error", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    sessionStorage.setItem("hai:mock-failure", "flash-write");
  });
  await startFlash(page);
  await askToStop(page);

  // Cancel stays, but the error was never read out
  const error = page.locator("progress-view").getByRole("alert");
  await expect(error).toBeFocused({ timeout: 30000 });
  await expect(error).toHaveText(
    "The drive is in use. Close any applications using it, then try again."
  );
  expect(await focusOnPage(page)).toBe(false);
  await expect(error).toBeFocused();
});

test("stopping a flash continues from the step while it stops", async ({
  page,
}) => {
  test.setTimeout(60000);
  await startFlash(page);
  await askToStop(page);

  // From here the flash talks to a backend that takes its time to stop
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      isTauri: boolean;
      __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> };
    };
    testWindow.isTauri = true;
    testWindow.__TAURI_INTERNALS__ = {
      invoke: (cmd) =>
        cmd === "cancel_flash" ? new Promise(() => {}) : Promise.resolve(),
    };
  });
  await page
    .getByRole("button", { name: "Stop installation", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Cancel hid while the dialog had the focus to give back to it
  await expect(cancel(page)).toBeHidden();
  const heading = page.locator("progress-view").getByRole("heading");
  await expect(heading).toBeFocused();
  expect(await focusOnPage(page)).toBe(false);
  await expect(heading).toBeFocused();
});

test.describe("on a Mac", () => {
  test.use({ platform: "macos" });

  test("a VM install that can no longer stop while asking continues from the step", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.clock.install();
    await page.goto("/");
    await page.getByRole("button", { name: "Let's go" }).click();
    await page.getByRole("button", { name: "Virtual machine" }).click();
    const next = page.locator("wizard-shell .footer-right wa-button");
    // Enabled once the UTM check found UTM installed
    await expect(next).toHaveJSProperty("disabled", false);
    await next.click();
    await expect(page.locator("utm-configure-view")).toBeVisible();
    await next.click();
    await expect(page.locator("utm-confirm-view")).toBeVisible();
    await next.click();
    await expect(cancel(page)).toBeVisible();

    // Hold the download while the question opens
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
    await askToStop(page);
    // On to creating the VM, which can't be stopped: the question goes, and
    // Cancel with it, while the dialog has the focus
    await page.clock.runFor(4000);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(cancel(page)).toBeHidden();
    await expect(
      page.locator("utm-progress-view").getByRole("heading")
    ).toBeFocused();

    await page.clock.resume();
    await expect(
      page
        .locator("utm-success-view")
        .getByRole("heading", { name: "You're all set!" })
    ).toBeFocused({ timeout: 30000 });
  });
});
