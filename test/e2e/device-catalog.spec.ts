import { expect, test } from "./fixtures.js";

test("catalog navigation preserves selection without a Lit mount-update warning", async ({
  page,
}) => {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("change-in-update"))
      warnings.push(message.text());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .locator('option-card[heading="Raspberry Pi & other boards"]')
    .click();
  await page.locator("device-selection-view device-card").first().click();
  await expect(page.locator("drive-selection-view")).toBeVisible();
  await page.locator("wizard-shell .header wa-button").click();
  await expect(page.locator("device-selection-view")).toBeVisible();
  // The board stays chosen once the catalog is in again
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const state = "/src/state/wizard-state.ts";
        const { wizardState } = (await import(
          state
        )) as typeof import("../../src/state/wizard-state.js");
        const { device, deviceCatalogReady } =
          wizardState.getState().selections;
        return deviceCatalogReady ? device : "loading";
      })
    )
    .toBe("rpi5");
  expect(warnings).toEqual([]);
});

test("runtime catalog preserves loading, failure and retry", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const mockPath = "/test/unit/tauri-ipc.ts";
    const dataPath = "/src/api/mock-data.ts";
    const { mockTauriIpc } = await import(mockPath);
    const { MOCK_MANIFEST } = await import(dataPath);
    let calls = 0;
    const bridge = window as unknown as { failCatalog: () => void };
    mockTauriIpc((command: string) => {
      if (command !== "get_manifest") throw new Error(`Unexpected ${command}`);
      calls++;
      if (calls === 1)
        return new Promise((_resolve, reject) => {
          bridge.failCatalog = () =>
            reject({
              code: "network",
              message: "Version service unavailable",
              retryable: true,
              details: {},
            });
        });
      return {
        ...MOCK_MANIFEST,
        devices: MOCK_MANIFEST.devices.filter(
          (device: { haos: { board: string } }) =>
            ["rpi5-64", "odroid-n2"].includes(device.haos.board)
        ),
      };
    });
    await customElements.whenDefined("device-selection-view");
    document.body.style.padding = "24px";
    document.body.replaceChildren(
      document.createElement("device-selection-view")
    );
  });
  await expect(
    page.getByText("Loading devices...", { exact: true })
  ).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { failCatalog: () => void }).failCatalog()
  );
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Raspberry Pi 5", { exact: true })).toBeVisible();
  await expect(page.getByText("ODROID-N2/N2+", { exact: true })).toBeVisible();
  await expect(page.getByText("Raspberry Pi 4", { exact: true })).toHaveCount(
    0
  );
});
