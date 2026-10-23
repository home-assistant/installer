import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

type TestWindow = typeof window & {
  isTauri: boolean;
  __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown> };
  resumeLookup: () => void;
  connectionCount: number;
};

// Installed only after entering the connection view, so other browser fixtures
// keep their existing behavior. Each Playwright test has its own page/context.
async function mockLookupFailure(page: Page, expired: boolean) {
  await page.evaluate(
    ({ expired }) => {
      const testWindow = window as TestWindow;
      let lookupCount = 0;
      testWindow.connectionCount = 0;
      testWindow.isTauri = true;
      testWindow.__TAURI_INTERNALS__ = {
        invoke: async (cmd) => {
          if (cmd === "proxmox_list_nodes") {
            lookupCount++;
            if (lookupCount === 1) {
              throw {
                message: expired ? "Session expired" : "Temporary failure",
                code: expired ? "proxmox_session_expired" : "proxmox_api",
                retryable: !expired,
                details: {},
              };
            }
            // Hold recovery open so Next's loading state is observable without
            // sleeps or assumptions about browser/backend timing.
            await new Promise<void>((resolve) => {
              testWindow.resumeLookup = resolve;
            });
          }
          switch (cmd) {
            // A trusted certificate: no confirmation before the login
            case "proxmox_certificate_fingerprint":
              return null;
            case "proxmox_connect":
              testWindow.connectionCount++;
              return {
                server_url: "https://pve.example:8006",
                ticket: `ticket-${testWindow.connectionCount}`,
                csrf_token: "test-csrf",
              };
            case "proxmox_list_nodes":
              return [{ name: "pve", status: "online" }];
            case "proxmox_list_storage":
              return [
                {
                  name: "local",
                  storage_type: "dir",
                  active: true,
                  content: ["iso", "import"],
                  available: 100 * 1024 ** 3,
                },
                {
                  name: "local-lvm",
                  storage_type: "lvmthin",
                  active: true,
                  content: ["images"],
                  available: 100 * 1024 ** 3,
                },
              ];
            case "proxmox_get_next_vm_id":
              return 123;
            case "proxmox_list_bridges":
              return [
                { name: "vmbr0", network_type: "bridge", comments: null },
              ];
            case "proxmox_check_vm_config":
              return null;
            case "get_haos_release":
              return { version: "18.0", assets: [] };
            default:
              throw new Error(`Unexpected IPC command: ${cmd}`);
          }
        },
      };
    },
    { expired }
  );
}

async function connect(page: Page) {
  const view = page.locator("proxmox-connect-view");
  await view.locator("#server-url").fill("https://pve.example:8006");
  await view.locator("#username").fill("root@pam");
  await view.locator("#password").fill("test-password");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("proxmox-configure-view")).toBeVisible();
}

async function finishRecovery(page: Page, { retried = false } = {}) {
  const view = page.locator("proxmox-configure-view");
  const next = page.getByRole("button", { name: "Next", exact: true });
  await page.waitForFunction(
    () => typeof (window as TestWindow).resumeLookup === "function"
  );
  if (retried) {
    // Try again stays, busy and focused, until the lookups are back; the
    // error is empty meanwhile, so the same failure would be read out again
    const retry = view.getByRole("button", { name: "Try again", exact: true });
    await expect(view.locator(".error > wa-button")).toHaveAttribute(
      "loading",
      ""
    );
    await expect(retry).toBeFocused();
    await expect(view.locator("[data-focus-alert]")).toHaveText("");
  } else {
    await expect(view.locator("[data-focus-alert]")).toHaveCount(0);
    await expect(view).toContainText("Loading nodes");
  }
  await expect(next).toBeDisabled();
  await page.evaluate(() => (window as TestWindow).resumeLookup());
  await expect(next).toBeEnabled();
  if (retried) {
    // The settings took its place, so the focus goes on from their heading
    await expect(
      view.getByRole("heading", { name: "Configure virtual machine" })
    ).toBeFocused();
  }
  await next.click();
  const confirmation = page.locator("proxmox-confirm-view");
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("Node: pve");
  await expect(confirmation).toContainText("Storage: local-lvm");
  await expect(confirmation).toContainText("ID: 123");
  await expect(confirmation).toContainText("Version 18.0");
}

test.describe("Proxmox configuration recovery", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Let's go" }).click();
    await page.locator('option-card[heading="Proxmox server"]').click();
    await expect(page.locator("proxmox-connect-view")).toBeVisible();
  });

  test("retries a temporary proxmox_list_nodes failure through confirmation", async ({
    page,
  }) => {
    await mockLookupFailure(page, false);
    await connect(page);
    const view = page.locator("proxmox-configure-view");
    // The view shows the safe message for the code, not the remote text,
    // and focuses it to read it out
    const error = view.locator("[data-focus-alert]");
    await expect(error).toHaveText(
      "Proxmox could not complete the request. Check the server, account permissions, and connection."
    );
    await expect(error).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Next", exact: true })
    ).toBeDisabled();
    await view.getByRole("button", { name: "Try again", exact: true }).click();
    await finishRecovery(page, { retried: true });
    expect(
      await page.evaluate(() => (window as TestWindow).connectionCount)
    ).toBe(1);
  });

  test("reconnects after an expired session from proxmox_list_nodes", async ({
    page,
  }) => {
    await mockLookupFailure(page, true);
    await connect(page);
    const view = page.locator("proxmox-configure-view");
    await expect(view.locator("[data-focus-alert]")).toHaveText(
      "Your Proxmox session expired. Reconnect to Proxmox to continue."
    );
    await expect(
      page.getByRole("button", { name: "Next", exact: true })
    ).toBeDisabled();
    await expect(
      view.getByRole("button", { name: "Try again", exact: true })
    ).toHaveCount(0);
    await view.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.locator("proxmox-connect-view")).toBeVisible();
    await expect(page.locator("proxmox-connect-view #password")).toHaveValue(
      ""
    );
    await connect(page);
    await finishRecovery(page);
    expect(
      await page.evaluate(() => (window as TestWindow).connectionCount)
    ).toBe(2);
  });
});
