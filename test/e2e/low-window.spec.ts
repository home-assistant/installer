import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

/**
 * How high the header, content and footer of a screen are in a window of
 * `width` by `height`. Step names wrap by width, so only windows of one width
 * compare.
 */
async function bars(page: Page, view: string, width: number, height: number) {
  await page.setViewportSize({ width, height });
  return page.locator(view).evaluate((element) => {
    const part = (selector: string) =>
      element.shadowRoot!.querySelector(selector)?.getBoundingClientRect()
        .height ?? 0;
    return {
      header: part(".header"),
      content: part(".content"),
      footer: part(".footer"),
    };
  });
}

// The smallest window, 800 by 750, zoomed to 200% is 400 by 375. There the
// header and footer get thinner, so the step keeps more of the height. A
// window that isn't zoomed keeps them as they are.
test("a low window leaves more of its height to the step", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .getByRole("button", { name: "Raspberry Pi & other boards" })
    .click();
  await expect(page.locator("wizard-shell")).toBeVisible();

  const tall = await bars(page, "wizard-shell", 800, 1000);
  const unzoomed = await bars(page, "wizard-shell", 800, 720);
  expect(unzoomed.header).toBeCloseTo(tall.header, 0);
  expect(unzoomed.footer).toBeCloseTo(tall.footer, 0);

  // Each gives back at least the half of its padding it drops
  const narrow = await bars(page, "wizard-shell", 400, 1000);
  const zoomed = await bars(page, "wizard-shell", 400, 375);
  expect(narrow.header - zoomed.header).toBeGreaterThanOrEqual(16);
  expect(narrow.footer - zoomed.footer).toBeGreaterThanOrEqual(16);
  expect(zoomed.content).toBeGreaterThan(375 / 2);

  // Back, Cancel and Next lose at most the space around their text. Picking
  // a board goes on, to the drive step with its Next.
  await page.locator("device-card").first().click();
  await expect(page.locator("drive-selection-view")).toBeVisible();
  for (const name of ["Back", "Cancel", "Next"]) {
    const button = page.getByRole("button", { name, exact: name !== "Back" });
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    expect(
      await button.evaluate((element) => getComputedStyle(element).fontSize)
    ).toBe("16px");
  }
});

test("the screens before the install flow get the same thinner header", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await expect(page.locator("path-selection-view")).toBeVisible();
  const back = page.getByRole("button", { name: "Back", exact: false });

  const tall = await bars(page, "path-selection-view", 400, 1000);
  const zoomed = await bars(page, "path-selection-view", 400, 375);
  expect(tall.header - zoomed.header).toBeGreaterThanOrEqual(16);
  const before = (await back.boundingBox())!;

  await page
    .getByRole("button", { name: "Raspberry Pi & other boards" })
    .click();
  await expect(page.locator("wizard-shell")).toBeVisible();
  const after = (await back.boundingBox())!;
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(after.height).toBeCloseTo(before.height, 0);
});
