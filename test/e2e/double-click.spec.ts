import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

// The first click of a double-click moves on, and the second lands on the
// next step's button in the same place. That one must do nothing.

const nextButton = (page: Page) =>
  page.locator("wizard-shell").locator(".footer-right wa-button");

async function openDriveStep(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .locator('option-card[heading="Raspberry Pi & other boards"]')
    .click();
  // A board with Wi-Fi, so the step after the drive is Wi-Fi
  await page
    .locator("device-selection-view")
    .getByRole("button", { name: "Raspberry Pi 5", exact: true })
    .click();
  await page.locator("drive-selection-view drive-card").first().click();
  await expect(nextButton(page)).not.toHaveAttribute("disabled");
}

test("a double-click on Next on the drive step stops at Wi-Fi", async ({
  page,
}) => {
  await openDriveStep(page);

  await nextButton(page).dblclick();

  await expect(page.locator("wifi-view")).toBeVisible();
  await expect(page.locator("confirmation-view")).toHaveCount(0);
});

test("a double-click on Skip while waiting for Home Assistant doesn't close", async ({
  page,
}) => {
  await openDriveStep(page);
  await page.evaluate(async () => {
    const state = "/src/state/wizard-state.ts";
    const { wizardState } = (await import(
      state
    )) as typeof import("../../src/state/wizard-state.js");
    const steps = wizardState.getState().steps;
    wizardState.goToStep(steps.findIndex((step) => step.id === "setup"));
  });
  await expect(nextButton(page)).toHaveText("Skip");

  // Closing does nothing in the browser, so count the presses of Next: on
  // the last step, a second one is Close
  await page.evaluate(() => {
    const shell = document
      .querySelector("app-shell")!
      .shadowRoot!.querySelector("wizard-shell")!;
    const counted = window as typeof window & { nextPresses: number };
    counted.nextPresses = 0;
    shell.addEventListener("wizard-next", () => counted.nextPresses++);
  });
  await nextButton(page).dblclick();

  await expect(page.locator("device-done-view")).toBeVisible();
  await expect(nextButton(page)).toHaveText("Close");
  const presses = await page.evaluate(
    () => (window as typeof window & { nextPresses: number }).nextPresses
  );
  expect(presses).toBe(1);
});
