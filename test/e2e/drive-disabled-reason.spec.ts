import { expect, test } from "./fixtures.js";

// A drive that can't be picked is faded, but the line saying why is the only
// explanation the user gets, so it has to stay readable.

// WCAG relative luminance of an opaque rgb() colour
function luminance(color: string) {
  const [r, g, b] = color
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map((value) => {
      const v = Number(value) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function contrast(foreground: string, background: string) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a
  );
  return (light + 0.05) / (dark + 0.05);
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`${colorScheme} disabled drive keeps the reason readable`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/");
    await page.locator("welcome-view").waitFor({ state: "attached" });
    await page.evaluate(() => {
      document.querySelector("app-shell")!.remove();
      const drive = document.createElement("drive-card");
      drive.setAttribute("name", "Small drive");
      drive.setAttribute("drive-size", "8000000000");
      drive.setAttribute("disabled", "");
      drive.setAttribute("disabled-reason", "Minimum 16 GB drive required");
      document.body.append(drive);
    });
    const card = page.locator("drive-card");
    await expect(card.locator(".details")).toHaveText(
      "Minimum 16 GB drive required"
    );

    const styles = await card.evaluate((host) => {
      const root = host.shadowRoot!;
      // Opacity multiplies down the tree, so check every box up to the host
      const opacity = (element: Element) => {
        let total = 1;
        for (
          let node: Element | null = element;
          node && node !== host;
          node = node.parentElement
        ) {
          total *= Number(getComputedStyle(node).opacity);
        }
        return total * Number(getComputedStyle(host).opacity);
      };
      const probe = document.body.appendChild(document.createElement("span"));
      probe.style.color = "var(--ha-secondary-text-color)";
      const secondary = getComputedStyle(probe).color;
      probe.remove();
      const details = root.querySelector(".details")!;
      return {
        secondary,
        reason: getComputedStyle(details).color,
        reasonOpacity: opacity(details),
        background: getComputedStyle(root.querySelector(".card")!)
          .backgroundColor,
        faded: [".icon-container", ".name", ".size"].map((selector) =>
          opacity(root.querySelector(selector)!)
        ),
      };
    });

    expect(styles.reason).toBe(styles.secondary);
    expect(styles.reasonOpacity).toBe(1);
    expect(contrast(styles.reason, styles.background)).toBeGreaterThanOrEqual(
      4.5
    );
    // It still reads as unavailable at a glance
    expect(styles.faded).toEqual([0.5, 0.5, 0.5]);
  });
}
