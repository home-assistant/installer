import { expect, test } from "@playwright/test";

test("catalog navigation preserves selection without a Lit mount-update warning", async ({
  page,
}) => {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("change-in-update"))
      warnings.push(message.text());
  });
  await page.goto("/");
  await page.locator("welcome-view wa-button").click();
  await page
    .locator('option-card[title="Raspberry Pi & other boards"]')
    .click();
  await page.locator("device-selection-view device-card").first().click();
  const next = page.locator("wizard-shell .footer-right wa-button");
  await next.click();
  await expect(page.locator("drive-selection-view")).toBeVisible();
  await page.locator("wizard-shell .header wa-button").click();
  await expect(page.locator("device-selection-view")).toBeVisible();
  await expect(next).toBeEnabled();
  expect(warnings).toEqual([]);
});

for (const width of [900, 390]) {
  test(`runtime catalog preserves loading, failure and retry at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 780 });
    await page.goto("/");
    await page.evaluate(async () => {
      const mockPath = "/test/unit/tauri-ipc.ts";
      const dataPath = "/src/api/mock-data.ts";
      const { mockTauriIpc } = await import(mockPath);
      const { MOCK_MANIFEST } = await import(dataPath);
      let calls = 0;
      const bridge = window as unknown as { failCatalog: () => void };
      mockTauriIpc((command: string) => {
        if (command !== "get_manifest")
          throw new Error(`Unexpected ${command}`);
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
    await page.screenshot({
      path: testInfo.outputPath(`catalog-error-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByText("Raspberry Pi 5", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("ODROID-N2/N2+", { exact: true })
    ).toBeVisible();
    await expect(page.getByText("Raspberry Pi 4", { exact: true })).toHaveCount(
      0
    );
    for (const image of await page.locator("device-card img").all()) {
      await image.evaluate((element: HTMLImageElement) => element.decode());
    }
    await page.screenshot({
      path: testInfo.outputPath(`filtered-catalog-${width}.png`),
      fullPage: true,
    });
  });

  for (const flow of ["sbc", "utm", "proxmox"]) {
    test(`${flow} confirmation shows its board release at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 780 });
      await page.goto("/");
      await page.evaluate(async (flow) => {
        const mockPath = "/test/unit/tauri-ipc.ts";
        const statePath = "/src/state/wizard-state.ts";
        const dataPath = "/src/api/mock-data.ts";
        const { mockTauriIpc } = await import(mockPath);
        const { wizardState } = await import(statePath);
        const { MOCK_MANIFEST } = await import(dataPath);
        const device = MOCK_MANIFEST.devices.find(
          (entry: { haos: { board: string } }) =>
            entry.haos.board === "odroid-n2"
        );
        wizardState.setSelection("device", device.id);
        wizardState.setSelection("deviceConfig", device.haos);
        wizardState.setSelection("deviceName", device.name);
        wizardState.setSelection("deviceImage", device.image_url);
        wizardState.setSelection("driveName", "Mock removable drive");
        wizardState.setSelection("drive", "/dev/mock");
        wizardState.setSelection("driveSize", 32_000_000_000);
        mockTauriIpc((command: string, args: { board?: string }) => {
          if (flow === "utm" && command === "get_utm_haos_release")
            return { version: "18.0", images: [] };
          if (command === "get_haos_release" && args.board === "odroid-n2")
            return { version: "18.2", images: [] };
          if (command === "get_haos_release" && args.board === "ova")
            return { version: "18.1", images: [] };
          throw new Error("Confirmation requested an unrelated release");
        });
        const tag =
          flow === "sbc" ? "confirmation-view" : `${flow}-confirm-view`;
        await customElements.whenDefined(tag);
        document.body.style.padding = "24px";
        document.body.replaceChildren(document.createElement(tag));
      }, flow);
      const version = { sbc: "18.2", utm: "18.0", proxmox: "18.1" }[flow];
      await expect(
        page.getByText(`Version ${version}`, { exact: true })
      ).toBeVisible();
      await expect(page.getByText("Version 18.3", { exact: true })).toHaveCount(
        0
      );
      for (const image of await page.locator("img").all()) {
        await image.evaluate((element: HTMLImageElement) => element.decode());
      }
      await page.screenshot({
        path: testInfo.outputPath(`${flow}-board-release-${width}.png`),
        fullPage: true,
      });
    });
  }
}
