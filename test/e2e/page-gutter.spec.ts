import { expect, test } from "@playwright/test";
import { skipWifiStep } from "./fixtures.js";

// The smallest window, 800 by 750, zoomed to 200% is 400 by 375. There, as on
// a regular window, Back, the content and Cancel and Next keep one distance
// from the sides of the window.
for (const [width, height, gutter] of [
  [400, 375, 16],
  [900, 780, 32],
] as const) {
  test(`every screen keeps a ${gutter}px gutter at ${width} by ${height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.getByRole("button", { name: "Let's go" }).click();
    const back = page.getByRole("button", { name: "Back", exact: false });
    async function expectGutter(view: string) {
      // In the flow, Back sits beside Next
      if (view !== "wizard-shell") {
        expect((await back.boundingBox())!.x).toBeCloseTo(gutter, 0);
      }
      // Where the content inside the padding starts and ends
      const content = await page.locator(view).evaluate((element) => {
        const part = element.shadowRoot!.querySelector(".content")!;
        const box = part.getBoundingClientRect();
        const style = getComputedStyle(part);
        return [
          box.left + parseFloat(style.paddingLeft),
          innerWidth - box.right + parseFloat(style.paddingRight),
        ];
      });
      expect(content[0]).toBeCloseTo(gutter, 0);
      expect(content[1]).toBeCloseTo(gutter, 0);
    }

    await expectGutter("path-selection-view");
    await page.getByRole("button", { name: "Other options" }).click();
    await expectGutter("other-options-view");
    await back.click();
    await page
      .getByRole("button", { name: "Raspberry Pi & other boards" })
      .click();
    await expectGutter("wizard-shell");
    const cancel = await page
      .getByRole("button", { name: "Cancel", exact: true })
      .boundingBox();
    expect(cancel!.x).toBeCloseTo(gutter, 0);
    const next = await page
      .getByRole("button", { name: "Next", exact: true })
      .boundingBox();
    expect(width - next!.x - next!.width).toBeCloseTo(gutter, 0);

    // The connection check before a flow, held on a failure
    await back.click();
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
    await expectGutter("connection-check-view");
    // Below the header it scrolls, rather than cutting off Try again
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    await retry.scrollIntoViewIfNeeded();
    await expect(retry).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`connection-check-${width}.png`),
    });
  });
}

// A recovery label makes Next its longest, and the footer the widest, in the
// smallest window. Back and Next go below Cancel rather than past the edge.
test("the footer keeps a recovery label inside the smallest window", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 400, height: 375 });
  await page.addInitScript(() =>
    sessionStorage.setItem("hai:mock-failure", "flash-disconnected")
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .getByRole("button", { name: "Raspberry Pi & other boards" })
    .click();
  const next = page.locator("wizard-shell .footer-right wa-button");
  await page.locator("device-selection-view device-card").first().click();
  await next.click();
  await page.locator("drive-selection-view drive-card").first().click();
  await next.click();
  await skipWifiStep(page);
  await next.click();
  await page.locator('confirm-dialog wa-button[variant="danger"]').click();
  await expect(next).toHaveText("Choose another drive", { timeout: 30000 });

  for (const button of [
    page.locator("wizard-shell .footer-left wa-button"),
    page.locator("wizard-shell .back"),
    next,
  ]) {
    const box = (await button.boundingBox())!;
    expect(Math.round(box.x)).toBeGreaterThanOrEqual(16);
    expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(400 - 16);
  }
});
