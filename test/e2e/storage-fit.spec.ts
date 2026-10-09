import { test, expect, type Page } from "@playwright/test";

const nextButton = (page: Page) =>
  page.locator("wizard-shell .footer-right wa-button");

async function capture(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await test.info().attach(name, { path, contentType: "image/png" });
}

for (const width of [1100, 390]) {
  test(`drive fit and decimal capacity stay consistent at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto("/?mock=true");
    await page.evaluate(async () => {
      const path = "/src/api/mock-data.ts";
      const { MOCK_BLOCK_DEVICES } = (await import(
        path
      )) as typeof import("../../src/api/mock-data.js");
      const original = MOCK_BLOCK_DEVICES[0];
      MOCK_BLOCK_DEVICES.splice(
        0,
        MOCK_BLOCK_DEVICES.length,
        {
          ...original,
          id: "/dev/small",
          name: "Small drive",
          size: 8_000_000_000,
        },
        {
          ...original,
          id: "/dev/limited",
          name: "Limited drive",
          size: 15_600_000_000,
        },
        {
          ...original,
          id: "/dev/recommended",
          name: "Recommended drive",
          size: 31_914_983_424,
        }
      );
    });
    await page.locator("welcome-view wa-button").click();
    await page
      .locator('option-card[title="Raspberry Pi & other boards"]')
      .click();
    await page.locator("device-selection-view device-card").first().click();
    await nextButton(page).click();

    const cards = page.locator("drive-selection-view drive-card");
    const small = cards.filter({ hasText: "Small drive" });
    const limited = cards.filter({ hasText: "Limited drive" });
    const recommended = cards.filter({ hasText: "Recommended drive" });
    await expect(small).toHaveJSProperty("disabled", true);
    await expect(small).toContainText("Minimum 16 GB drive required");
    await expect(limited).toHaveJSProperty("disabled", false);
    await expect(limited).toContainText("A 32 GB drive is recommended");
    await expect(recommended.locator(".capacity-warning")).toHaveCount(0);
    await expect(nextButton(page)).toHaveJSProperty("disabled", true);
    await limited.click();
    await expect(limited).toHaveJSProperty("checked", true);
    await expect(limited.locator(".size")).toHaveText("15.6 GB");
    await capture(page, `drive-fit-${width}`);

    // Check the card layout, including wrapped warning text, at both widths.
    for (const card of await cards.all()) {
      const fits = await card.evaluate((element) => {
        const root = element.shadowRoot!;
        const info = root.querySelector(".info")!.getBoundingClientRect();
        const size = root.querySelector(".size")!.getBoundingClientRect();
        return (
          info.right <= size.left &&
          element.getBoundingClientRect().right <= innerWidth
        );
      });
      expect(fits).toBe(true);
    }
    await small.scrollIntoViewIfNeeded();
    await capture(page, `drive-disabled-${width}`);

    await nextButton(page).click();
    await expect(page.locator("confirmation-view")).toContainText("15.6 GB");
    await nextButton(page).click();
    const dialog = page.locator("confirm-dialog");
    await expect(dialog.locator(".drive-details")).toContainText("15.6 GB");
    await capture(page, `drive-erase-${width}`);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("progress-view")).toHaveCount(0);
  });
}
