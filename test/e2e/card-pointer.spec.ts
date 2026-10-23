import { expect, test, type Page } from "@playwright/test";

// The option, device and drive cards light up under the pointer and give a
// little when pressed, all the same; with reduced motion they hold still

const tags = ["option-card", "device-card", "drive-card"];

async function showCards(page: Page) {
  await page.goto("/");
  await page.locator("welcome-view").waitFor({ state: "attached" });
  await page.evaluate(() => {
    document.querySelector("app-shell")!.remove();
    const option = document.createElement("option-card");
    option.setAttribute("heading", "Test option");
    const device = document.createElement("device-card");
    device.setAttribute("name", "Test device");
    const drive = document.createElement("drive-card");
    drive.setAttribute("name", "Test drive");
    document.body.append(option, device, drive);
  });
}

/** Presses the card and leaves the pointer down. */
async function press(page: Page, tag: string) {
  const box = (await page.locator(`${tag} .card`).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

test("the cards light up and give alike under the pointer", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await showCards(page);
  const hover = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("div"));
    probe.style.cssText =
      "border: 2px solid var(--ha-primary-color); box-shadow: var(--ha-card-hover-shadow)";
    const { borderTopColor, boxShadow } = getComputedStyle(probe);
    probe.remove();
    return { borderTopColor, boxShadow };
  });

  for (const tag of tags) {
    const card = page.locator(`${tag} .card`);
    await press(page, tag);
    await expect(card).toHaveCSS("border-top-color", hover.borderTopColor);
    await expect(card).toHaveCSS("box-shadow", hover.boxShadow);
    await expect(card).toHaveCSS("transform", "matrix(0.98, 0, 0, 0.98, 0, 0)");
    await page.mouse.up();
  }
});

test("the cards hold still when pressed with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await showCards(page);

  for (const tag of tags) {
    const card = page.locator(`${tag} .card`);
    await press(page, tag);
    await expect
      .poll(() => card.evaluate((el) => el.matches(":active")))
      .toBe(true);
    await expect(card).toHaveCSS("transform", "none");
    await page.mouse.up();
  }
});
