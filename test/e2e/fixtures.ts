import { test as base, expect, type Page } from "@playwright/test";
import tauriConfig from "../../crates/hai-desktop/tauri.conf.json" with { type: "json" };

export { expect };

/**
 * The browser mock's Proxmox storage only accepts Import once the user agreed
 * to enable it, so the configure step asks first. A revisit of the same server
 * in the same page finds it enabled and does not ask again.
 */
export async function approveProxmoxImport(page: Page) {
  const enable = page.getByRole("button", {
    name: "Enable Import...",
    exact: true,
  });
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect
    .poll(async () => (await enable.isVisible()) || (await next.isEnabled()))
    .toBe(true);
  if (!(await enable.isVisible())) return;

  await enable.click();
  await page
    .getByRole("button", { name: "Enable Import", exact: true })
    .click();
  // The section stays, busy, until storage has been read again
  await expect(
    page.locator("proxmox-configure-view .import-setting")
  ).toHaveCount(0);
}

/**
 * The VM step asks macOS whether the installer may control UTM only once the
 * user chooses to. The browser mock allows it right away.
 */
export async function allowUtmControl(page: Page) {
  const view = page.locator("utm-check-view");
  await view
    .getByRole("button", { name: "Allow control of UTM", exact: true })
    .click();
  await expect(view).toContainText(
    "Ready to create a Home Assistant virtual machine"
  );
}

/**
 * Boards with built-in Wi-Fi get an optional Wi-Fi step after the drive. Leave
 * Wi-Fi off and go on to Confirm; for other boards, Confirm is already there.
 */
export async function skipWifiStep(page: Page) {
  await expect(
    page.locator("wifi-view, confirmation-view").first()
  ).toBeVisible();
  if ((await page.locator("wifi-view").count()) > 0) {
    await page.locator("wizard-shell .footer-right wa-button").click();
  }
  await expect(page.locator("confirmation-view")).toBeVisible();
}

/**
 * Every page runs under the CSP the desktop app ships with, which dev does
 * not apply, and a test fails if anything runs into it. `platform` is an
 * explicit input to getPlatform(), independent of the browser project.
 */
export const test = base.extend<{ platform: "default" | "macos" }>({
  platform: ["default", { option: true }],
  page: async ({ page, platform, baseURL }, use) => {
    // Only the page itself. Unlike a function, a RegExp is matched without a
    // round trip to the test for every module the page loads.
    const origin = new URL(baseURL!).origin.replace(/\./g, "\\.");
    await page.route(new RegExp(`^${origin}/(\\?.*)?$`), async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy": tauriConfig.app.security.csp,
        },
      });
    });
    // Reported as they happen, so a test that loads the page again keeps them
    const violations: string[] = [];
    await page.exposeFunction("reportCspViolation", (violation: string) => {
      violations.push(violation);
    });
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        void (
          window as unknown as {
            reportCspViolation: (violation: string) => Promise<void>;
          }
        ).reportCspViolation(`${e.effectiveDirective} ${e.blockedURI}`);
      });
    });

    if (platform === "macos") {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "userAgent", {
          value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
          configurable: true,
        });
      });
    }
    await use(page);

    // What the last step showed may still be loading: an image only starts
    // once styles are applied, and its violation is reported a task later.
    // A page that draws no frames gets a second instead.
    if (!page.isClosed()) {
      await page
        .evaluate(
          () =>
            new Promise((resolve) => {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => setTimeout(resolve))
              );
              setTimeout(resolve, 1000);
            })
        )
        .catch(() => {});
    }
    expect(violations, "CSP violations").toEqual([]);
  },
});
