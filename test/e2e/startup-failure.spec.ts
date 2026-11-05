import { test, expect } from "./fixtures.js";

test("a shell that fails to load says so and how to report it", async ({
  page,
}) => {
  // Dev serves every module on its own, so one that doesn't arrive stands in
  // for any module that fails to load
  await page.route(/\/src\/components\/app-shell\.ts(\?.*)?$/, (route) =>
    route.abort()
  );
  await page.addInitScript(() => {
    window.open = (url) => {
      Object.assign(window, { openedUrl: String(url) });
      return null;
    };
  });
  await page.goto("/");

  const heading = page.getByRole("heading", {
    name: "The installer couldn't start",
  });
  await expect(heading).toBeVisible();
  const report = page.getByRole("link", { name: "Report a problem on GitHub" });
  await report.click();
  // Opened outside the installer, which stays where it is
  expect(await page.evaluate(() => Reflect.get(window, "openedUrl"))).toBe(
    await report.getAttribute("href")
  );
  await expect(heading).toBeVisible();
});
