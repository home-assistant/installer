import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

// With every drive too small, the radio group gives none of its cards a tab
// stop. The step has to say that none can be used, and the keyboard has to
// land somewhere that does.

/** Connect these drives to the browser mock, from the next scan on. */
async function connect(page: Page, sizes: Record<string, number>) {
  await page.evaluate(async (sizes) => {
    const path = "/src/api/mock-data.ts";
    const { MOCK_BLOCK_DEVICES } = (await import(
      path
    )) as typeof import("../../src/api/mock-data.js");
    const original = MOCK_BLOCK_DEVICES[0];
    MOCK_BLOCK_DEVICES.splice(
      0,
      MOCK_BLOCK_DEVICES.length,
      ...Object.entries(sizes).map(([name, size]) => ({
        ...original,
        id: `/dev/${name.toLowerCase().replace(/\W+/g, "-")}`,
        name,
        size,
        serial: name,
      }))
    );
  }, sizes);
}

test("explains a list of drives that are all too small, and keeps the keyboard on it", async ({
  page,
}) => {
  await page.goto("/?mock=true");
  await connect(page, { "Small drive": 8_000_000_000, "Tiny drive": 2e9 });
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .locator('option-card[heading="Raspberry Pi & other boards"]')
    .click();
  await page.locator("device-selection-view device-card").first().click();

  const view = page.locator("drive-selection-view");
  const why = view.locator(".no-usable-drive");
  const status = view.locator(".sr-only[role=status]");
  const refresh = view.locator(".drives-header wa-button");
  await expect(why).toHaveText(
    "None of these drives can be used. You need a drive of at least 16 GB. Connect one and select Refresh."
  );
  await expect(status).toHaveText("2 drives found, but none can be used");
  await expect(view.getByRole("radio", { disabled: true })).toHaveCount(2);
  await expect(why).toBeFocused();

  // Read in order: why, then what to do about it
  await page.keyboard.press("Tab");
  await expect(refresh).toBeFocused();

  // A drive big enough: the list says how many of them can be used
  await connect(page, {
    "Small drive": 8_000_000_000,
    "Tiny drive": 2e9,
    "Big drive": 64_000_000_000,
  });
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("3 drives found, 1 can be used");
  await expect(why).toHaveCount(0);
  await expect(refresh).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(view.getByRole("radio", { name: /Big drive/ })).toBeFocused();
});
