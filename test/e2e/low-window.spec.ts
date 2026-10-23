import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

/** How high the header, content and footer of a screen are */
async function bars(page: Page, view: string) {
  return page.locator(view).evaluate((element) => {
    const height = (selector: string) =>
      element.shadowRoot!.querySelector(selector)?.getBoundingClientRect()
        .height ?? 0;
    return {
      header: height(".header"),
      content: height(".content"),
      footer: height(".footer"),
    };
  });
}

// The smallest window, 800 by 750, zoomed to 200% is 400 by 375. There the
// header and footer get thinner, so the step keeps most of the height. A
// window that isn't zoomed keeps them as they are.
test("a low window leaves most of its height to the step", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .getByRole("button", { name: "Raspberry Pi & other boards" })
    .click();
  await expect(page.locator("wizard-shell")).toBeVisible();
  const regular = await bars(page, "wizard-shell");

  await page.setViewportSize({ width: 800, height: 720 });
  const unzoomed = await bars(page, "wizard-shell");
  expect(unzoomed.header).toBeCloseTo(regular.header, 0);
  expect(unzoomed.footer).toBeCloseTo(regular.footer, 0);

  await page.setViewportSize({ width: 400, height: 375 });
  const zoomed = await bars(page, "wizard-shell");
  expect(zoomed.header).toBeLessThan(regular.header);
  expect(zoomed.footer).toBeLessThan(regular.footer);
  expect(zoomed.content).toBeGreaterThanOrEqual(375 * 0.7);

  // Back, Cancel and Next only lose the space around their text
  for (const name of ["Back", "Cancel", "Next"]) {
    const button = page.getByRole("button", { name, exact: name !== "Back" });
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    expect(
      await button.evaluate((element) => getComputedStyle(element).fontSize)
    ).toBe("16px");
  }
});

test("Back stays put between the screens on a low window", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 375 });
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  const back = page.getByRole("button", { name: "Back", exact: false });
  await expect(page.locator("path-selection-view")).toBeVisible();
  const before = await back.boundingBox();

  await page
    .getByRole("button", { name: "Raspberry Pi & other boards" })
    .click();
  await expect(page.locator("wizard-shell")).toBeVisible();
  expect(await back.boundingBox()).toEqual(before);
});
