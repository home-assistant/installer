import { type Page } from "@playwright/test";
import { approveProxmoxImport, test, expect } from "./fixtures.js";

// Enter in a form's text field does what Next does, through the same path:
// it goes on once Next can, and does nothing while Next is off. Switches,
// sliders and selects keep Enter for themselves.

const next = (page: Page) =>
  page.locator("wizard-shell").locator(".footer-right wa-button");

async function start(page: Page, heading: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.locator(`option-card[heading="${heading}"]`).click();
  await expect(page.locator("wizard-shell")).toBeVisible();
}

test("Enter in a Wi-Fi field goes on once the network can be used", async ({
  page,
}) => {
  await start(page, "Raspberry Pi & other boards");
  // The first board has Wi-Fi, so its step comes after the drive
  await page.locator("device-selection-view device-card").first().click();
  await page.locator("drive-selection-view drive-card").first().click();
  await next(page).click();
  const wifi = page.locator("wifi-view");
  await expect(wifi).toBeVisible();

  // Enter leaves the switch as it is, and the step with it: Space still
  // turns it on here
  const toggle = wifi.getByRole("switch", { name: "Connect to Wi-Fi" });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  const network = wifi.getByRole("textbox", { name: "Network name" });
  await expect(network).toBeVisible();

  // Next is off, so Enter stays, and says what holds it back
  const password = wifi.locator("#wifi-password");
  await password.fill("1234567");
  await password.press("Enter");
  await expect(wifi.locator(".ssid-hint")).toHaveText(
    "Enter the network name."
  );
  await expect(wifi.locator(".password-hint")).toHaveText(
    "Use at least 8 characters."
  );
  await expect(page.locator("confirmation-view")).toHaveCount(0);

  await network.fill("Home");
  await password.fill("12345678");
  await password.press("Enter");
  await expect(page.locator("confirmation-view")).toBeVisible();
});

test.describe("on a Mac", () => {
  test.use({ platform: "macos" });

  test("Enter in the VM name goes on once it has one, not from a slider", async ({
    page,
  }) => {
    await start(page, "Virtual machine");
    // Once the UTM check found UTM installed
    await expect(next(page)).toHaveJSProperty("disabled", false);
    await next(page).click();
    const configure = page.locator("utm-configure-view");
    await expect(configure).toBeVisible();

    // Enter on a slider leaves the step: arrows still move it here
    const cores = configure.getByRole("slider", { name: "CPU cores" });
    await expect(cores).toHaveAttribute("aria-valuetext", "4 cores");
    await cores.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowRight");
    await expect(cores).toHaveAttribute("aria-valuetext", "6 cores");

    // Without a name Next is off, and so is Enter
    const name = configure.getByRole("textbox", { name: "Display name" });
    await name.fill("");
    await name.press("Enter");
    await expect(name).toBeFocused();
    await expect(page.locator("utm-confirm-view")).toHaveCount(0);

    await name.fill("my-home");
    await name.press("Enter");
    await expect(page.locator("utm-confirm-view")).toContainText("my-home");
  });
});

test("Enter connects to Proxmox, then checks the settings and goes on, not from a select", async ({
  page,
}) => {
  await start(page, "Proxmox server");
  const connect = page.locator("proxmox-connect-view");
  await connect.locator("#server-url").fill("https://192.168.1.100:8006");
  await connect.locator("#password").fill("test");
  await connect.locator("#password").press("Enter");

  const configure = page.locator("proxmox-configure-view");
  await expect(configure).toBeVisible();
  await approveProxmoxImport(page);
  await expect(next(page)).toHaveJSProperty("disabled", false);

  // Enter opens a select's list instead
  const node = configure.getByRole("combobox", { name: "Node", exact: true });
  await node.focus();
  await page.keyboard.press("Enter");
  await expect(node).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(node).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("proxmox-confirm-view")).toHaveCount(0);

  // An ID Proxmox can't take turns Next off, and Enter with it
  const vmId = configure.getByRole("spinbutton", { name: "VM ID" });
  await vmId.fill("99");
  await vmId.press("Enter");
  await expect(vmId).toBeFocused();
  await expect(page.locator("proxmox-confirm-view")).toHaveCount(0);

  await vmId.fill("251");
  await vmId.press("Enter");
  await expect(page.locator("proxmox-confirm-view")).toContainText("251");
});

test("Enter in the ISO location checks it, and goes on once it can be used", async ({
  page,
}) => {
  await start(page, "Mini PC or other computer");
  await page
    .locator("minipc-setup-method-view option-card")
    .filter({ hasText: "I need to boot from USB" })
    .click();
  await page
    .locator("minipc-media-view option-card")
    .filter({ hasText: "ISO file" })
    .click();
  const location = page.locator("live-iso-location-view");
  const name = location.getByLabel("File name");
  await expect(name).toHaveValue(/^hai-live-haos-.+\.iso$/);

  // Without a name Next is off, and so is Enter
  await name.fill("");
  await name.press("Enter");
  await expect(name).toBeFocused();
  await expect(page.locator("live-usb-summary-view")).toHaveCount(0);

  // The check Next runs first says what is wrong, and the step stays
  await name.fill("sub/stick.iso");
  await name.press("Enter");
  await expect(location).toContainText(
    "Enter a file name without folder separators."
  );
  await expect(page.locator("live-usb-summary-view")).toHaveCount(0);

  await name.fill("my-stick.iso");
  await name.press("Enter");
  await expect(page.locator("live-usb-summary-view")).toContainText(
    "my-stick.iso"
  );
});
