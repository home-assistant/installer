import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

// The UTM check and Proxmox connect say how a check went in the theme's
// colors. Their own copies had a light green and orange the card barely set
// apart, and an error tint that ignored the theme.

test.use({ platform: "macos" });

// sRGB channels (0 to 1) of a computed colour, rgb() or color(srgb …), painted
// over an opaque background
function paint(color: string, background = [1, 1, 1]) {
  const [r, g, b, alpha = 1] = color.match(/[\d.]+/g)!.map(Number);
  // rgb() counts to 255, color(srgb …) to 1
  const scale = color.startsWith("color(") ? 1 : 255;
  return [r, g, b].map(
    (value, i) => (value / scale) * alpha + background[i] * (1 - alpha)
  );
}

function luminance(rgb: number[]) {
  const [r, g, b] = rgb.map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  );
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

// WCAG contrast of a colour drawn over layers listed from the top down, so the
// error tint is blended with the card under it
function contrast(foreground: string, ...backgrounds: string[]) {
  const base = backgrounds.reduceRight(
    (under, color) => paint(color, under),
    [1, 1, 1]
  );
  const values = [luminance(paint(foreground, base)), luminance(base)].sort(
    (a, b) => b - a
  );
  return (values[0] + 0.05) / (values[1] + 0.05);
}

type TestWindow = typeof window & {
  isTauri: boolean;
  utmInstalled: boolean;
  __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> };
};

/**
 * Answer native commands from the page, instead of the browser mock. UTM is
 * missing until the page sets `utmInstalled`.
 */
async function answerNatively(page: Page, { proxmoxError = false } = {}) {
  await page.evaluate((proxmoxError) => {
    const testWindow = window as TestWindow;
    testWindow.isTauri = true;
    testWindow.utmInstalled = false;
    testWindow.__TAURI_INTERNALS__ = {
      invoke: async (cmd) => {
        if (cmd === "utm_supported") return true;
        if (cmd === "check_utm_status")
          return testWindow.utmInstalled
            ? {
                installed: true,
                path: "/Applications/UTM.app",
                version: "4.5.0",
              }
            : { installed: false, path: null, version: null };
        // A trusted certificate: nothing to confirm before the login
        if (cmd === "proxmox_certificate_fingerprint") return null;
        if (cmd === "proxmox_connect" && proxmoxError)
          throw {
            code: "proxmox_action_required",
            message:
              "Authentication failed. Please check your username and password.",
            retryable: false,
            details: {
              message_key: "backend.proxmox.authentication_failed",
              message_params: {},
            },
          };
        // The connection check, Automation and diagnostics logging
        return undefined;
      },
    };
  }, proxmoxError);
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`${colorScheme} UTM check sets its icons apart from the card`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/");
    await answerNatively(page);
    await page.getByRole("button", { name: "Let's go" }).click();
    await page.locator('option-card[heading="Virtual machine"]').click();

    const view = page.locator("utm-check-view");
    for (const kind of ["warning", "success"]) {
      if (kind === "success") {
        await page.evaluate(() => {
          (window as TestWindow).utmInstalled = true;
        });
        await view.getByRole("button", { name: "I've installed UTM" }).click();
      }
      const icon = view.locator(`.status-row.status-${kind} .status-icon`);
      await expect(icon).toBeVisible();
      const colors = await icon.evaluate((svg) => ({
        icon: getComputedStyle(svg).fill,
        card: getComputedStyle(svg.closest(".status-card")!).backgroundColor,
      }));
      // An icon needs 3:1 (WCAG 1.4.11)
      expect(contrast(colors.icon, colors.card), kind).toBeGreaterThanOrEqual(
        3
      );
    }
  });

  test(`${colorScheme} Proxmox connection error uses the theme's error box`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/");
    await answerNatively(page, { proxmoxError: true });
    await page.getByRole("button", { name: "Let's go" }).click();
    await page.locator('option-card[heading="Proxmox server"]').click();

    const view = page.locator("proxmox-connect-view");
    await view.locator("#server-url").fill("https://192.168.1.100:8006");
    await view.locator("#password").fill("wrong-password");
    await page.locator("wizard-shell .footer-right wa-button").click();

    const error = view.locator(".status-row.status-error");
    await expect(error).toContainText("Authentication failed");
    const colors = await error.evaluate((row) => {
      // The theme's tint, as the browser resolves it
      const probe = document.body.appendChild(document.createElement("span"));
      probe.style.backgroundColor = "var(--ha-error-background)";
      probe.style.border = "1px solid var(--ha-error-border)";
      const theme = getComputedStyle(probe);
      const expected = {
        background: theme.backgroundColor,
        border: theme.borderTopColor,
      };
      probe.remove();
      const color = (selector: string) =>
        getComputedStyle(row.querySelector(selector)!).color;
      return {
        expected,
        background: getComputedStyle(row).backgroundColor,
        border: getComputedStyle(row).borderTopColor,
        card: getComputedStyle(row.closest(".connect-card")!).backgroundColor,
        icon: getComputedStyle(row.querySelector(".status-icon")!).fill,
        text: [
          color(".status-title"),
          color(".status-description"),
          color(".error-help a"),
        ],
      };
    });
    expect(colors.background).toBe(colors.expected.background);
    expect(colors.border).toBe(colors.expected.border);
    for (const text of colors.text) {
      expect(
        contrast(text, colors.background, colors.card)
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(
      contrast(colors.icon, colors.background, colors.card)
    ).toBeGreaterThanOrEqual(3);
  });
}
