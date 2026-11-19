import { test, expect } from "./fixtures.js";

// The browser mock's network has Home Assistant at home, one at the cabin
// whose owner has yet to onboard it, and a device that installs it
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
  await expect(page.locator("html")).toHaveAttribute(
    "data-opened-url",
    "http://192.168.1.30:8123"
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
