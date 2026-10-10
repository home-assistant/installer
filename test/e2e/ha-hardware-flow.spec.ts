import { test, expect, type Page } from "@playwright/test";

// The browser mock serves the device catalog, the drives and a simulated
// write, so each device can go all the way to its next steps.

const next = (page: Page) =>
  page.locator("wizard-shell .footer-right wa-button");
const back = (page: Page) => page.locator("wizard-shell .header wa-button");
const cancel = (page: Page) =>
  page.locator("wizard-shell .footer-left wa-button");

async function openHaHardware(page: Page) {
  await page.goto("/");
  await page.locator("welcome-view wa-button").click();
  await page.locator('option-card[title="Home Assistant hardware"]').click();
  await expect(
    page.locator("ha-hardware-device-selection-view device-card").first()
  ).toBeVisible();
}

const scenarios = [
  {
    value: "ha-green",
    name: "Home Assistant Green",
    connect: "Insert a microSD card into this computer",
    version: "Green installer, April 10, 2024",
    notice: "the installer reinstalls Home Assistant OS",
    steps: [
      "needs internet access during the reset",
      "Shut down system",
      "until it clicks",
      "heartbeat pattern",
    ],
    guide: "https://support.nabucasa.com/hc/en-us/articles/25162566451485",
  },
  {
    value: "ha-yellow-cm4",
    name: "Home Assistant Yellow with CM4",
    connect: "Insert a USB flash drive into this computer",
    version: "Yellow installer, October 25, 2023",
    notice: "the installer reinstalls Home Assistant OS",
    steps: [
      "Unplug every USB device",
      "press and hold the red and blue buttons",
      "only works while Home Assistant OS is installed",
      "remove the USB flash drive",
    ],
    guide: "https://support.nabucasa.com/hc/en-us/articles/25484982657309",
  },
  {
    value: "ha-yellow-cm5",
    name: "Home Assistant Yellow with CM5",
    connect: "sudo ./rpiboot -d mass-storage-gadget64",
    version: "Yellow installer, October 25, 2023",
    notice: "the installer reinstalls Home Assistant OS",
    steps: ["JP1 back to UART", "installer on the eMMC"],
    guide: "https://support.nabucasa.com/hc/en-us/articles/25485061432093",
  },
  {
    value: "ha-blue",
    name: "Home Assistant Blue",
    connect: "ums /dev/mmcblk0",
    version: "Version 16.3",
    notice: "Home Assistant included",
    steps: ["boot mode toggle back to MMC", "Preparing Home Assistant"],
    guide: "https://www.home-assistant.io/installation/odroid",
  },
];

test.describe("Home Assistant hardware flow", () => {
  test("the option is offered on path selection", async ({ page }) => {
    await page.goto("/");
    await page.locator("welcome-view wa-button").click();

    const card = page.locator('option-card[title="Home Assistant hardware"]');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute(
      "description",
      "Home Assistant Green, Yellow, or Blue by Nabu Casa"
    );
  });

  test("lists each device, with both Yellow compute modules", async ({
    page,
  }) => {
    await openHaHardware(page);

    const cards = page.locator("ha-hardware-device-selection-view device-card");
    await expect(cards).toHaveCount(4);
    for (const { name } of scenarios) {
      await expect(
        page.getByRole("radio", { name, exact: true })
      ).toBeVisible();
    }
    await expect(next(page)).toHaveJSProperty("disabled", true);
    await expect(back(page)).toHaveJSProperty("disabled", true);
  });

  for (const scenario of scenarios) {
    test(`${scenario.name} goes from drive to next steps`, async ({ page }) => {
      test.setTimeout(60000);
      await openHaHardware(page);

      await page.locator(`device-card[value="${scenario.value}"]`).click();
      await next(page).click();

      const drive = page.locator("drive-selection-view");
      const instructions = drive.locator("ha-hardware-connect-instructions");
      await expect(instructions).toContainText(scenario.connect);
      await drive.locator("drive-card").first().click();
      await next(page).click();

      const confirmation = page.locator("confirmation-view");
      await expect(confirmation).toContainText(scenario.name);
      await expect(confirmation.locator(".summary-card")).toContainText(
        scenario.version
      );
      await expect(confirmation.locator(".notice")).toContainText(
        scenario.notice
      );
      await expect(confirmation.locator(".notice")).toContainText(
        "Create a backup first"
      );
      await next(page).click();
      await page.locator('confirm-dialog wa-button[variant="danger"]').click();
      await expect(page.locator("progress-view")).toBeVisible();

      const success = page.locator("ha-hardware-success-view");
      await expect(success).toBeVisible({ timeout: 45000 });
      const steps = success.locator(".next-steps");
      for (const step of scenario.steps) {
        await expect(steps).toContainText(step);
      }
      await expect(steps).toContainText("homeassistant.local:8123");
      await expect(success.locator(".next-steps-footer a")).toHaveAttribute(
        "href",
        scenario.guide
      );

      await expect(next(page)).toHaveText("Done");
      await next(page).click();
      await expect(page.locator("welcome-view")).toBeVisible();
    });
  }

  test("Back keeps the device and Cancel leaves the flow", async ({ page }) => {
    await openHaHardware(page);
    await page.locator('device-card[value="ha-yellow-cm5"]').click();
    await next(page).click();
    await expect(
      page.locator("ha-hardware-connect-instructions")
    ).toContainText("Set jumper JP1 to USB");

    await back(page).click();
    await expect(
      page.locator('device-card[value="ha-yellow-cm5"]')
    ).toHaveJSProperty("checked", true);
    await expect(next(page)).toHaveJSProperty("disabled", false);

    // Another Yellow is prepared differently, so its instructions follow.
    await page.locator('device-card[value="ha-yellow-cm4"]').click();
    await next(page).click();
    await expect(
      page.locator("ha-hardware-connect-instructions")
    ).toContainText("USB flash drive");

    await cancel(page).click();
    await expect(page.locator("welcome-view")).toBeVisible();
  });
});
