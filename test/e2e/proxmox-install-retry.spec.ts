import { approveProxmoxImport, test, expect } from "./fixtures.js";

// A download that fails before the VM exists leaves nothing on the server,
// so Try again runs the install again with the same login and settings
test("tries a Proxmox install that failed before the VM existed again", async ({
  page,
}) => {
  test.setTimeout(90000);
  // Set before navigation, but consumed once so the retry succeeds
  await page.addInitScript(() => {
    sessionStorage.setItem("hai:mock-failure", "proxmox-download");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.locator('option-card[heading="Proxmox server"]').click();

  const next = page.locator("wizard-shell .footer-right wa-button");
  const connect = page.locator("proxmox-connect-view");
  await connect.locator("#server-url").fill("https://192.0.2.10:8006");
  await connect.locator("#username").fill("test@pam");
  await connect.locator("#password").fill("test-only");
  await expect(next).toHaveJSProperty("disabled", false);
  await next.click();
  await expect(page.locator("proxmox-configure-view")).toBeVisible();
  await approveProxmoxImport(page);
  await expect(next).toHaveJSProperty("disabled", false);
  await next.click();
  const confirmedId = page
    .locator("proxmox-confirm-view")
    .getByText(/\(ID: \d+\)/);
  await expect(confirmedId).toBeVisible();
  const vmId = /\(ID: (\d+)\)/.exec((await confirmedId.textContent())!)![1];
  await next.click();

  const progress = page.locator("proxmox-progress-view");
  await expect(progress.locator(".error-message")).toHaveText(
    "The image could not be downloaded. Check your connection and available storage.",
    { timeout: 30000 }
  );
  await expect(next).toHaveText("Try again");
  await expect(page.locator("wizard-shell .footer-left wa-button")).toHaveText(
    "Cancel"
  );

  await next.click();
  await expect(progress.locator(".error-message")).toHaveCount(0);
  const success = page.locator("proxmox-success-view");
  await expect(success).toBeVisible({ timeout: 45000 });
  // The same settings, and no login on the way
  await expect(success).toContainText(`(VM ${vmId})`);
});
