import { type Locator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

// The Mini PC's method and media steps have no Next: picking a card moves on
// at once, the way Next does

// Traverse the real tab order instead of focusing controls programmatically.
async function tabTo(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  for (let count = 0; count < 40; count++) {
    if (await control.evaluate((el) => el.matches(":focus"))) return;
    await page.keyboard.press("Tab");
  }
  await expect(control).toBeFocused();
}

async function openMethod(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.getByRole("button", { name: "Mini PC or other computer" }).click();
  await expect(page.locator("minipc-setup-method-view")).toBeVisible();
}

for (const [key, card, heading] of [
  [
    "Enter",
    "I can connect the drive",
    "Which processor does your mini PC have?",
  ],
  ["Space", "I need to boot from USB", "Create bootable media"],
] as const) {
  test(`${key} on "${card}" continues from the next step's heading`, async ({
    page,
  }) => {
    await openMethod(page);
    const next = page.getByRole("button", { name: "Next", exact: true });
    await expect(next).toHaveCount(0);

    await tabTo(page, page.getByRole("button", { name: card }));
    await page.keyboard.press(key);

    // A screen reader goes on from the new step, not from the top
    await expect(page.getByRole("heading", { name: heading })).toBeFocused();
  });
}

test("a picked medium continues at once, and Back returns to the choice", async ({
  page,
}) => {
  await openMethod(page);
  await tabTo(
    page,
    page.getByRole("button", { name: "I need to boot from USB" })
  );
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Create bootable media" })
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Next", exact: true })
  ).toHaveCount(0);

  await tabTo(page, page.getByRole("button", { name: "Save an ISO file" }));
  await page.keyboard.press("Enter");
  await expect(page.locator("live-iso-location-view")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Next", exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "Back", exact: false }).click();
  await expect(page.locator("minipc-media-view")).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: false }).click();
  await expect(page.locator("minipc-setup-method-view")).toBeVisible();
});
