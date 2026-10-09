import { test, expect } from "@playwright/test";

for (const mode of ["native", "invalid", "rejected", "stalled"] as const) {
  test(`locale discovery ${mode} still starts the English UI`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((mode) => {
      Object.defineProperty(navigator, "languages", { value: ["en-GB"] });
      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          invoke: async (command: string) => {
            if (command !== "plugin:os|locale")
              throw new Error(`Unexpected command: ${command}`);
            if (mode === "rejected") throw new Error("Locale unavailable");
            if (mode === "stalled") return new Promise(() => undefined);
            // This delay proves the app waits before importing static wizard labels.
            await new Promise((resolve) => setTimeout(resolve, 100));
            Object.assign(window, {
              localeComponentsLoadedEarly: !!customElements.get("app-shell"),
            });
            return mode === "invalid" ? "invalid_locale" : "en-IN";
          },
        },
      });
    }, mode);
    await page.goto("/");
    await expect(page.locator("welcome-view wa-button")).toContainText(
      "Let's go"
    );
    await expect(page.locator("html")).toHaveAttribute(
      "lang",
      mode === "native" ? "en-IN" : "en-GB"
    );
    await expect(page).toHaveTitle("Home Assistant Installer");
    if (mode === "native" || mode === "invalid") {
      expect(
        await page.evaluate(() =>
          Reflect.get(window, "localeComponentsLoadedEarly")
        )
      ).toBe(false);
    }
    await page.locator("welcome-view wa-button").click();
    await expect(
      page.locator('option-card[title="Proxmox server"]')
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}
