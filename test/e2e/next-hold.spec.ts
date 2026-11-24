import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

// Once Home Assistant is ready, the wait goes on by itself to where to find
// it, and Skip turns into Close in the same place. A click meant for Skip,
// a moment too late, must not close the installer.

const nextButton = (page: Page) =>
  page.locator("wizard-shell").locator(".footer-right wa-button");

/** How often Next was pressed, not counting the step going on by itself */
const presses = (page: Page) =>
  page.evaluate(
    () => (window as typeof window & { nextPresses: number }).nextPresses
  );

test("a click meant for Skip, a moment too late, doesn't press Close", async ({
  page,
}) => {
  // The browser mock takes a while to get Home Assistant ready
  test.setTimeout(60000);
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .locator('option-card[heading="Raspberry Pi & other boards"]')
    .click();
  await page
    .locator("device-selection-view")
    .getByRole("button", { name: "Raspberry Pi 5", exact: true })
    .click();
  await page.locator("drive-selection-view drive-card").first().click();
  await expect(nextButton(page)).not.toHaveAttribute("disabled");
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
  // the last step, one is Close
  await page.evaluate(() => {
    const shell = document
      .querySelector("app-shell")!
      .shadowRoot!.querySelector("wizard-shell")!;
    const counted = window as typeof window & { nextPresses: number };
    counted.nextPresses = 0;
    shell.addEventListener("wizard-next", (event) => {
      if (event.target === shell) counted.nextPresses++;
    });
  });
  const box = (await nextButton(page).boundingBox())!;
  const skip = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(skip.x, skip.y);

  await expect(nextButton(page)).toHaveText("Close", { timeout: 45000 });
  await page.mouse.click(skip.x, skip.y);

  await expect(page.locator("device-done-view")).toBeVisible();
  expect(await presses(page)).toBe(0);

  // A moment later, Close is Close
  await expect
    .poll(async () => {
      await page.mouse.click(skip.x, skip.y);
      return presses(page);
    })
    .toBeGreaterThan(0);
});
