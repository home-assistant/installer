import { test, expect, type Page } from "@playwright/test";

async function openMediaChoice(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .locator('option-card[heading="Mini PC or other computer"]')
    .click();
  await page
    .locator("minipc-setup-method-view")
    .locator("option-card")
    .filter({ hasText: "I need to boot from USB" })
    .click();
  await expect(page.locator("minipc-media-view")).toBeVisible();
}

function next(page: Page, name = "Next") {
  return page.getByRole("button", { name, exact: true }).click();
}

test("writes a bootable USB stick", async ({ page }) => {
  await openMediaChoice(page);
  await page
    .locator("minipc-media-view")
    .locator("option-card")
    .filter({ hasText: "USB stick" })
    .click();

  const drives = page.locator("drive-selection-view");
  await expect(drives).toContainText("Choose the USB stick to write");
  await drives.getByRole("radio").first().click();
  await next(page);

  const summary = page.locator("live-usb-summary-view");
  await expect(summary).toContainText("Ready to create");
  await expect(summary).toContainText("will be erased");
  await next(page, "Create");
  await page
    .getByRole("button", { name: "Erase and install", exact: true })
    .click();

  await expect(page.locator("live-usb-progress-view")).toContainText(
    "Don't remove the USB stick",
    { timeout: 20000 }
  );

  await expect(page.locator("live-usb-success-view")).toContainText(
    "Your USB stick is ready.",
    { timeout: 20000 }
  );
  await expect(page.locator("live-usb-success-view")).toContainText(
    "type erase to confirm"
  );
  await expect(page.locator("live-usb-success-view")).toContainText(
    "eject it before you disconnect it"
  );
});

test("saves an ISO file without the erase confirmation", async ({ page }) => {
  await openMediaChoice(page);
  await page
    .locator("minipc-media-view")
    .locator("option-card")
    .filter({ hasText: "ISO file" })
    .click();

  const location = page.locator("live-iso-location-view");
  await expect(location.getByLabel("Folder")).toHaveValue("Downloads");
  await expect(location.getByLabel("File name")).toHaveValue(
    /^hai-live-haos-.+\.iso$/
  );
  await location.getByLabel("File name").fill("");
  await expect(
    page.getByRole("button", { name: "Next", exact: true })
  ).toBeDisabled();
  await location.getByLabel("File name").fill("my-stick.iso");
  await next(page);

  await expect(page.locator("live-usb-summary-view")).toContainText(
    "my-stick.iso"
  );
  await next(page, "Create");
  await expect(page.locator("confirm-dialog")).not.toHaveAttribute("open");

  const success = page.locator("live-usb-success-view");
  await expect(success).toContainText("Your ISO file is saved.", {
    timeout: 20000,
  });
  await expect(success).toContainText("my-stick.iso");
  await expect(
    success.getByRole("button", { name: "Show in folder" })
  ).toBeVisible();
});

test("asks before replacing an existing ISO file", async ({ page }) => {
  await openMediaChoice(page);
  await page
    .locator("minipc-media-view")
    .locator("option-card")
    .filter({ hasText: "ISO file" })
    .click();
  const location = page.locator("live-iso-location-view");
  await location.getByLabel("File name").fill("existing.iso");

  await next(page);
  const dialog = location.locator("info-dialog");
  await expect(dialog).toContainText("Replace the existing file?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(location).toBeVisible();

  await next(page);
  await dialog.getByRole("button", { name: "Replace" }).click();
  await expect(page.locator("live-usb-summary-view")).toContainText(
    "Replaces the existing file."
  );
});

function chooseMedia(page: Page, name: "USB stick" | "ISO file") {
  return page
    .locator("minipc-media-view")
    .locator("option-card")
    .filter({ hasText: name })
    .click();
}

function nextButton(page: Page) {
  return page.getByRole("button", { name: "Next", exact: true });
}

async function startUsbWrite(page: Page) {
  await chooseMedia(page, "USB stick");
  await page.locator("drive-selection-view").getByRole("radio").first().click();
  await next(page);
  await next(page, "Create");
  await page
    .getByRole("button", { name: "Erase and install", exact: true })
    .click();
}

test("explains when the USB stick program is missing", async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("hai:mock-live-usb", "hai-live-missing")
  );
  await openMediaChoice(page);
  await chooseMedia(page, "ISO file");

  await expect(page.locator("live-usb-gate")).toContainText(
    "The USB stick program is missing"
  );
  await expect(nextButton(page)).toBeDisabled();
});

test("asks for administrator access before listing sticks", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("hai:mock-live-usb", "needs-admin")
  );
  await openMediaChoice(page);
  await chooseMedia(page, "USB stick");

  const gate = page.locator("live-usb-gate");
  await expect(gate).toContainText("Administrator access needed");
  await expect(
    gate.getByRole("button", { name: "Restart as administrator" })
  ).toBeVisible();
  await expect(page.locator("drive-selection-view")).toBeHidden();
  await expect(nextButton(page)).toBeDisabled();
});

test("a failed write can be tried again", async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("hai:mock-failure", "flash-write")
  );
  await openMediaChoice(page);
  await startUsbWrite(page);

  const progress = page.locator("live-usb-progress-view");
  await expect(progress).toContainText("The drive is in use", {
    timeout: 20000,
  });
  await expect(progress).not.toContainText("Don't remove the USB stick");
  await page.getByRole("button", { name: "Try again", exact: true }).click();

  await expect(page.locator("live-usb-success-view")).toContainText(
    "Your USB stick is ready.",
    { timeout: 20000 }
  );
});

test("stopping a USB stick asks first and can be tried again", async ({
  page,
}) => {
  await openMediaChoice(page);
  await startUsbWrite(page);
  const progress = page.locator("live-usb-progress-view");
  await expect(progress).toBeVisible();
  const stopDialog = page.locator("app-shell > info-dialog.stop-dialog");
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });

  await cancel.click();
  await expect(stopDialog).toContainText("If writing to the drive has started");
  await stopDialog.getByRole("button", { name: "Keep installing" }).click();
  await expect(stopDialog.getByText("Stop the installation?")).toBeHidden();

  await cancel.click();
  await stopDialog.getByRole("button", { name: "Stop installation" }).click();
  await expect(progress).toContainText("Stopped.");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("live-usb-success-view")).toContainText(
    "Your USB stick is ready.",
    { timeout: 20000 }
  );
});

test("stopping an ISO says nothing was saved", async ({ page }) => {
  await openMediaChoice(page);
  await chooseMedia(page, "ISO file");
  await next(page);
  await next(page, "Create");
  await expect(page.locator("live-usb-progress-view")).toBeVisible();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const stopDialog = page.locator("app-shell > info-dialog.stop-dialog");
  await expect(stopDialog).toContainText("The ISO file won't be saved.");
  await stopDialog.getByRole("button", { name: "Stop installation" }).click();
  await expect(page.locator("live-usb-progress-view")).toContainText(
    "Stopped. No ISO file was saved."
  );
});

test("an unplugged stick leads back to the stick list", async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("hai:mock-failure", "flash-disconnected")
  );
  await openMediaChoice(page);
  await startUsbWrite(page);

  await expect(page.locator("live-usb-progress-view")).toContainText(
    "disconnected",
    { timeout: 20000 }
  );
  await page
    .getByRole("button", { name: "Choose another drive", exact: true })
    .click();
  await expect(page.locator("drive-selection-view")).toBeVisible();
});

test("a bad save location is shown before anything starts", async ({
  page,
}) => {
  await openMediaChoice(page);
  await chooseMedia(page, "ISO file");
  const location = page.locator("live-iso-location-view");
  await location.getByLabel("File name").fill("sub/stick.iso");

  await next(page);
  await expect(location).toContainText(
    "Enter a file name without folder separators."
  );
  await expect(page.locator("live-usb-summary-view")).toHaveCount(0);

  await location.getByLabel("File name").fill("stick.iso");
  await expect(location).not.toContainText("folder separators");
  await next(page);
  await expect(page.locator("live-usb-summary-view")).toBeVisible();
});
