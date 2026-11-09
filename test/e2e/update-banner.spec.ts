import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const RELEASE_URL =
  "https://github.com/home-assistant/installer/releases/tag/2026.12.0";

/** Open the welcome screen with the browser mock offering 2026.12.0. */
async function offerUpdate(page: Page, failure?: string) {
  await page.addInitScript((failure) => {
    sessionStorage.setItem("hai:mock-update", "2026.12.0");
    if (failure) sessionStorage.setItem("hai:mock-failure", failure);
  }, failure);
  await page.goto("/");
}

function letsGo(page: Page) {
  return page.getByRole("button", { name: "Let's go" });
}

test("the welcome screen offers an update and installs it", async ({
  page,
}) => {
  await offerUpdate(page);
  const banner = page.locator("update-banner");
  await expect(banner.getByRole("status")).toHaveText(
    "A new version of the installer is available: 2026.12.0"
  );
  await expect(
    banner.getByRole("link", { name: /What's new/ })
  ).toHaveAttribute("href", RELEASE_URL);

  await banner.getByRole("button", { name: "Update and restart" }).click();
  await expect(banner.getByRole("status")).toHaveText(
    "The update is installed. The installer restarts in a moment."
  );
  // On Windows the app exits as the update's installer takes over
  await expect(letsGo(page)).toBeDisabled();
  await expect(banner.getByRole("button", { name: "Not now" })).toHaveCount(0);
});

test("a failed update offers a retry and the download", async ({ page }) => {
  await offerUpdate(page, "update-install");
  const banner = page.locator("update-banner");

  await banner.getByRole("button", { name: "Update and restart" }).click();
  await expect(banner.getByRole("status")).toHaveText(
    "The update could not be installed. Download the new version and install it yourself instead."
  );
  await expect(banner.getByRole("button", { name: "Download" })).toBeVisible();
  await expect(letsGo(page)).toBeEnabled();

  await banner.getByRole("button", { name: "Try again" }).click();
  await expect(banner.getByRole("status")).toHaveText(
    "The update is installed. The installer restarts in a moment."
  );
});

test("Not now hides the update and leaves the way on open", async ({
  page,
}) => {
  await offerUpdate(page);
  const banner = page.locator("update-banner");

  await banner.getByRole("button", { name: "Not now" }).click();
  await expect(banner).toBeHidden();
  await letsGo(page).click();
  await expect(page.locator("path-selection-view")).toBeVisible();
});
