import { test, expect } from "./fixtures.js";

// The browser mock's network has Home Assistant at home, one at the cabin
// that serves HTTPS and whose owner has yet to onboard it, and a device that
// installs it
test("the welcome screen offers the Home Assistants on the network", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.open = (url) => {
      document.documentElement.dataset.openedUrl = String(url);
      return null;
    };
  });
  await page.goto("/");
  const found = page.getByRole("region", {
    name: "Home Assistant on your network",
  });
  const links = found.getByRole("link");
  await expect(links).toHaveCount(3);
  // Each says what it is ready for, and that it leaves the installer
  for (const [index, name] of [
    "Cabin 192.168.1.30:8123 Not set up yet Opens in your browser.",
    "Home 192.168.1.20:8123 Opens in your browser.",
    "Home (preparing setup) 192.168.1.101 Installing Opens in your browser.",
  ].entries()) {
    await expect(links.nth(index)).toHaveAccessibleName(name);
  }

  // Let's go stays where it was, above them
  const letsGo = page.getByRole("button", { name: "Let's go" });
  const button = (await letsGo.boundingBox())!;
  expect(button.y + button.height).toBeLessThan((await found.boundingBox())!.y);

  await links.first().click();
  // Where it says it is reached, over HTTPS
  await expect(page.locator("html")).toHaveAttribute(
    "data-opened-url",
    "https://192.168.1.30:8123/"
  );
  // Opening one starts no flow
  await expect(page.locator("welcome-view")).toBeVisible();
});

test("Let's go stays where it is when Home Assistant shows below it", async ({
  page,
}) => {
  // The window the installer opens in
  await page.setViewportSize({ width: 900, height: 780 });
  // An empty network for "/?empty", the browser mock's own otherwise
  await page.addInitScript(() => {
    if (location.search === "?empty") {
      sessionStorage.setItem("hai:mock-network", "empty");
    } else {
      sessionStorage.removeItem("hai:mock-network");
    }
  });
  const letsGo = page.getByRole("button", { name: "Let's go" });
  const found = page.getByRole("region", {
    name: "Home Assistant on your network",
  });

  await page.goto("/?empty");
  await expect(letsGo).toBeVisible();
  const alone = (await letsGo.boundingBox())!;

  await page.goto("/");
  await expect(found).toBeVisible();
  expect((await letsGo.boundingBox())!.y).toBeCloseTo(alone.y, 0);
});

test("more Home Assistant than fit scroll by in one row", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 780 });
  await page.addInitScript(() =>
    sessionStorage.setItem("hai:mock-network", "many")
  );
  await page.goto("/");
  const found = page.getByRole("region", {
    name: "Home Assistant on your network",
  });
  const links = found.getByRole("link");
  await expect(links).toHaveCount(8);
  const row = page.locator("welcome-view scroll-row");
  const back = row.locator(".back");
  const forward = row.locator(".forward");

  // One row, the next card showing in part past the edge
  const tops = await links.evaluateAll((cards) =>
    cards.map((card) => Math.round(card.getBoundingClientRect().top))
  );
  expect(new Set(tops).size).toBe(1);
  await expect(links.nth(3)).toBeInViewport({ ratio: 0.1 });
  await expect(links.nth(3)).not.toBeInViewport({ ratio: 0.9 });
  await expect(forward).toBeVisible();
  await expect(back).toBeHidden();

  await forward.click();
  await expect(back).toBeVisible();

  // The keyboard goes through the cards, each scrolling into sight
  await links.last().focus();
  await expect(links.last()).toBeInViewport({ ratio: 1 });
  await expect(forward).toBeHidden();

  await back.click();
  await expect(forward).toBeVisible();
});
