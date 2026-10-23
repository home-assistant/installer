import tauriConfig from "../../crates/hai-desktop/tauri.conf.json" with { type: "json" };
import { test, expect } from "./fixtures.js";

test.use({ platform: "macos" });

// Dev and the other specs run without the policy the desktop app ships with,
// so nothing there notices what it blocks. Serve the page with it here.
test.beforeEach(async ({ page }) => {
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy": tauriConfig.app.security.csp,
        },
      });
    }
  );
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations =
      violations;
    document.addEventListener("securitypolicyviolation", (e) => {
      violations.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
  });
});

test("shows a field's error icon under the desktop app's CSP", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.locator('option-card[heading="Virtual machine"]').click();
  const next = page.locator("wizard-shell .footer-right wa-button");
  await expect(next).toHaveJSProperty("disabled", false);
  await next.click();

  const configView = page.locator("utm-configure-view");
  await configView.getByRole("textbox", { name: "Display name" }).clear();
  const hint = configView.locator('wa-input[custom-error] > [slot="hint"]');
  await expect(hint).toContainText("Enter a name");

  // A mask that can't load hides the icon without a trace on the page, so
  // load the same image the way the mask does, through img-src
  const loaded = await hint.evaluate(async (hint) => {
    const icon = getComputedStyle(hint, "::before");
    const mask = icon.maskImage || icon.webkitMaskImage;
    const url = /^url\("(.*)"\)$/.exec(mask)?.[1];
    if (!url) return `no icon in ${mask}`;
    const image = new Image();
    image.src = url;
    return image.decode().then(
      () => "loaded",
      () => "blocked"
    );
  });
  const violations = await page.evaluate(
    () => (window as unknown as { cspViolations: string[] }).cspViolations
  );
  expect({ loaded, violations }).toEqual({ loaded: "loaded", violations: [] });
});
