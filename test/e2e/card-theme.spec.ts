import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

// The device and drive cards extend Web Awesome's radio, but should look like
// the option and summary cards next to them: Web Awesome's own dark surface is
// a navy darker than the page, and its quiet text a bluish grey.

/** A CSS color value as the browser computes it, so it compares as text. */
function resolveColor(page: Page, value: string) {
  return page.evaluate((value) => {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = value;
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, value);
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`${colorScheme} device and drive cards match the other cards`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/");
    await page.locator("welcome-view").waitFor({ state: "attached" });
    await page.evaluate(() => {
      document.querySelector("app-shell")!.remove();
      const option = document.createElement("option-card");
      option.setAttribute("heading", "Test option");
      option.setAttribute("description", "Test description");
      const device = document.createElement("device-card");
      device.setAttribute("name", "Test device");
      const drive = document.createElement("drive-card");
      drive.setAttribute("name", "Test drive");
      drive.setAttribute("model", "Test model");
      document.body.append(option, device, drive);
    });

    const option = page.locator("option-card .card");
    const cardBackground = await resolveColor(
      page,
      "var(--ha-card-background)"
    );
    await expect(option).toHaveCSS("background-color", cardBackground);
    const radius = await option.evaluate(
      (card) => getComputedStyle(card).borderTopLeftRadius
    );
    const quietText = await page
      .locator("option-card .description")
      .evaluate((text) => getComputedStyle(text).color);

    for (const tag of ["device-card", "drive-card"]) {
      const card = page.locator(`${tag} .card`);
      await expect(card).toHaveCSS("background-color", cardBackground);
      await expect(card).toHaveCSS("border-top-left-radius", radius);
    }
    await expect(page.locator("drive-card .details")).toHaveCSS(
      "color",
      quietText
    );

    // The ring around the chosen drive is the theme's primary color, not
    // the light blue of the old Home Assistant theme
    const ring = await resolveColor(
      page,
      "color-mix(in srgb, var(--ha-primary-color) 20%, transparent)"
    );
    await page.locator("drive-card").click();
    await page.mouse.move(0, 0);
    await expect(page.locator("drive-card .card")).toHaveCSS(
      "box-shadow",
      `${ring} 0px 0px 0px 3px`
    );
  });
}
