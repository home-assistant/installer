import { test as base, expect } from "@playwright/test";

export { expect };

/** Explicit platform input to getPlatform(), independent of the browser project. */
export const test = base.extend<{ platform: "default" | "macos" }>({
  platform: ["default", { option: true }],
  page: async ({ page, platform }, use) => {
    if (platform === "macos") {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "userAgent", {
          value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
          configurable: true,
        });
      });
    }
    await use(page);
  },
});
