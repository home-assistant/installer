import { test, expect, type Page } from "@playwright/test";

type LookupCommand =
  | "proxmox_list_nodes"
  | "proxmox_list_storage"
  | "proxmox_get_next_vm_id";

type TestWindow = typeof window & {
  __TAURI__: object;
  __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown> };
  resumeLookup: () => void;
  connectionCount: number;
};

// Installed only after entering the connection view, so other browser fixtures
// keep their existing behavior. Each Playwright test has its own page/context.
async function mockLookupFailure(
  page: Page,
  command: LookupCommand,
  expired: boolean
) {
  await page.evaluate(
    ({ command, expired }) => {
      const testWindow = window as TestWindow;
      let lookupCount = 0;
      testWindow.connectionCount = 0;
      testWindow.__TAURI__ = {};
      testWindow.__TAURI_INTERNALS__ = {
        invoke: async (cmd) => {
          if (cmd === command) {
            lookupCount++;
            if (lookupCount === 1) {
              throw {
                message: expired ? "Session expired" : "Temporary failure",
                session_expired: expired,
              };
            }
            // Hold recovery open so Next's loading state is observable without
            // sleeps or assumptions about browser/backend timing.
            await new Promise<void>((resolve) => {
              testWindow.resumeLookup = resolve;
            });
          }
          switch (cmd) {
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
                  name: "local-lvm",
                  storage_type: "lvmthin",
                  active: true,
                  content: ["images"],
                  available: 100 * 1024 ** 3,
                  total: 200 * 1024 ** 3,
                },
              ];
            case "proxmox_get_next_vm_id":
              return 123;
            case "get_haos_release":
              return { version: "18.0", assets: [] };
            default:
              throw new Error(`Unexpected IPC command: ${cmd}`);
          }
        },
      };
    },
    { command, expired }
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

async function finishRecovery(page: Page) {
  const view = page.locator("proxmox-configure-view");
  const next = page.getByRole("button", { name: "Next", exact: true });
  await page.waitForFunction(
    () => typeof (window as TestWindow).resumeLookup === "function"
  );
  await expect(view.getByRole("alert")).toHaveCount(0);
  await expect(view).toContainText(/Loading (nodes|storage)/);
  await expect(next).toBeDisabled();
  await page.evaluate(() => (window as TestWindow).resumeLookup());
  await expect(next).toBeEnabled();
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
    await page.locator("welcome-view wa-button").click();
    await page.locator('option-card[title="Proxmox server"]').click();
    await expect(page.locator("proxmox-connect-view")).toBeVisible();
  });

  for (const command of [
    "proxmox_list_nodes",
    "proxmox_list_storage",
    "proxmox_get_next_vm_id",
  ] as const) {
    test(`retries a temporary ${command} failure through confirmation`, async ({
      page,
    }) => {
      await mockLookupFailure(page, command, false);
      await connect(page);
      const view = page.locator("proxmox-configure-view");
      await expect(view.getByRole("alert")).toHaveText("Temporary failure");
      await expect(
        page.getByRole("button", { name: "Next", exact: true })
      ).toBeDisabled();
      await view
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await finishRecovery(page);
      expect(
        await page.evaluate(() => (window as TestWindow).connectionCount)
      ).toBe(1);
    });

    test(`reconnects after an expired session from ${command}`, async ({
      page,
    }) => {
      await mockLookupFailure(page, command, true);
      await connect(page);
      const view = page.locator("proxmox-configure-view");
      await expect(view.getByRole("alert")).toHaveText("Session expired");
      await expect(
        page.getByRole("button", { name: "Next", exact: true })
      ).toBeDisabled();
      await expect(
        view.getByRole("button", { name: "Try again", exact: true })
      ).toHaveCount(0);
      await view
        .getByRole("button", { name: "Reconnect", exact: true })
        .click();
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
  }
});
