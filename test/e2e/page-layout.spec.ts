import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

/**
 * The room left above what a screen shows below its header, and below it,
 * inside the padding of its content. A focused error may have scrolled it,
 * so it is measured as if it hadn't.
 */
async function room(page: Page, view: string) {
  return page.locator(view).evaluate((element) => {
    const content = element.shadowRoot!.querySelector(".content")!;
    const box = content.getBoundingClientRect();
    const style = getComputedStyle(content);
    const first = content.firstElementChild!.getBoundingClientRect();
    const last = content.lastElementChild!.getBoundingClientRect();
    return {
      above:
        first.top + content.scrollTop - box.top - parseFloat(style.paddingTop),
      below:
        box.bottom -
        parseFloat(style.paddingBottom) -
        (last.bottom + content.scrollTop),
    };
  });
}

/** Fail the connection check before a flow, so its screen stays. */
async function failConnection(page: Page) {
  await page.evaluate(() => {
    const bridge = window as unknown as Record<string, unknown>;
    bridge.isTauri = true;
    bridge.__TAURI_INTERNALS__ = {
      invoke: async () => {
        throw {
          code: "network",
          message: "Cannot reach version.home-assistant.io.",
          retryable: true,
          details: {},
        };
      },
    };
  });
  await page
    .getByRole("button", { name: "Raspberry Pi & other boards" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Unable to connect" })
  ).toBeVisible();
}

// The screens before the install flow center what they show in a tall
// window. In a low one it starts at the top and scrolls, instead of being cut
// off above.
for (const [width, height, centered] of [
  [900, 1200, true],
  [400, 375, false],
] as const) {
  test(`the screens before the flow ${centered ? "center their content" : "scroll from the top"} at ${width} by ${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.getByRole("button", { name: "Let's go" }).click();
    const back = page.getByRole("button", { name: "Back", exact: false });
    async function expectRoom(view: string) {
      const { above, below } = await room(page, view);
      if (centered) {
        expect(above).toBeGreaterThan(50);
        expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
      } else {
        expect(above).toBeCloseTo(0, 0);
      }
    }

    await expect(page.locator("path-selection-view")).toBeVisible();
    await expectRoom("path-selection-view");
    await page.getByRole("button", { name: "Other options" }).click();
    await expect(page.locator("other-options-view")).toBeVisible();
    await expectRoom("other-options-view");
    await back.click();
    await failConnection(page);
    await expectRoom("connection-check-view");
  });
}
