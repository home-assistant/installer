import { test, expect } from "@playwright/test";
import type {
  ProxmoxCredentials,
  ProxmoxSession,
} from "../../src/api/types.js";

interface TotpWindow {
  __TAURI__: object;
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args: unknown) => Promise<unknown>;
  };
  totpAttempts: ProxmoxCredentials[];
  authenticatedCalls: string[];
}

test.describe("Proxmox TOTP login", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.locator("welcome-view wa-button").click();
    await page.locator('option-card[title="Proxmox server"]').click();
    await expect(page.locator("proxmox-connect-view")).toBeVisible();

    // Use the actual shell and command wrapper, replacing only native IPC.
    await page.evaluate(() => {
      const win = window as unknown as TotpWindow;
      const session: ProxmoxSession = {
        server_url: "https://pve.example:8006",
        ticket: "completed-fixture-ticket",
        csrf_token: "fixture-csrf",
      };
      win.__TAURI__ = {};
      win.totpAttempts = [];
      win.authenticatedCalls = [];
      win.__TAURI_INTERNALS__ = {
        invoke: async (cmd, args) => {
          if (cmd === "proxmox_connect") {
            const { credentials } = args as {
              credentials: ProxmoxCredentials;
            };
            win.totpAttempts.push(credentials);
            if (!credentials.totp) {
              throw "Proxmox two-factor authentication: This account requires an authenticator app code. Enter the current code and try again.";
            }
            if (credentials.totp !== "012345") {
              throw "Proxmox two-factor authentication: Proxmox rejected the second-factor login. Check your current authenticator app code and try again.";
            }
            return session;
          }

          // The connection check before each flow is not a Proxmox request
          if (cmd === "check_connection") return undefined;

          win.authenticatedCalls.push(cmd);
          const { session: supplied } = args as { session: ProxmoxSession };
          if (
            win.totpAttempts[win.totpAttempts.length - 1]?.totp !== "012345" ||
            supplied.ticket !== session.ticket ||
            supplied.csrf_token !== session.csrf_token
          ) {
            throw new Error(
              "An authenticated request used an incomplete session"
            );
          }
          if (cmd === "proxmox_list_nodes")
            return [{ name: "pve", status: "online" }];
          if (cmd === "proxmox_get_next_vm_id") return 100;
          if (cmd === "proxmox_list_storage")
            return [
              {
                name: "local",
                active: true,
                content: ["images", "import"],
                available: 100000000000,
              },
            ];
          throw new Error(`Unexpected command: ${cmd}`);
        },
      };
    });
    await page
      .getByRole("textbox", { name: "Server URL" })
      .fill("https://pve.example:8006");
    await page
      .locator("proxmox-connect-view input[type=password]")
      .fill("fixture-password");
  });

  test("retries missing and rejected codes, clears the code, and advances only after authentication", async ({
    page,
  }) => {
    const connect = page.locator("proxmox-connect-view");
    const code = page.getByRole("textbox", {
      name: "Authenticator app code (optional)",
      exact: true,
    });
    const next = page.getByRole("button", { name: "Next", exact: true });

    await next.click();
    await expect(connect.locator(".status-description")).toContainText(
      "Proxmox two-factor authentication: This account requires an authenticator app code."
    );
    await expect(page.locator("proxmox-configure-view")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as unknown as TotpWindow).authenticatedCalls
      )
    ).toEqual([]);
    await expect(code).toHaveValue("");

    await code.fill("111111");
    await next.click();
    await expect(connect.locator(".status-description")).toContainText(
      "Proxmox rejected the second-factor login."
    );
    await expect(code).toHaveValue("");
    await expect(page.locator("proxmox-configure-view")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as unknown as TotpWindow).authenticatedCalls
      )
    ).toEqual([]);

    // Keep the submitted input so success must clear it before removing the view.
    const submittedCode = await code.elementHandle();
    expect(submittedCode).not.toBeNull();
    await code.fill(" 012345 ");
    await next.click();
    await expect(page.locator("proxmox-configure-view")).toBeVisible();
    await expect(next).toBeEnabled();
    await expect.poll(() => submittedCode!.inputValue()).toBe("");
    expect(
      await page.evaluate(() =>
        (window as unknown as TotpWindow).totpAttempts.map(
          ({ totp }) => totp ?? null
        )
      )
    ).toEqual([null, "111111", "012345"]);
    expect(
      await page.evaluate(
        () => (window as unknown as TotpWindow).authenticatedCalls
      )
    ).toEqual(
      expect.arrayContaining([
        "proxmox_list_nodes",
        "proxmox_get_next_vm_id",
        "proxmox_list_storage",
      ])
    );
    await submittedCode!.dispose();
  });

  test("does not retain or submit a code after cancelling and reopening the wizard", async ({
    page,
  }) => {
    const code = page.getByRole("textbox", {
      name: "Authenticator app code (optional)",
      exact: true,
    });
    await code.fill("012345");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("welcome-view")).toBeVisible();
    await expect(page.locator("proxmox-connect-view")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as TotpWindow).totpAttempts)
    ).toEqual([]);

    await page.locator("welcome-view wa-button").click();
    await page.locator('option-card[title="Proxmox server"]').click();
    await expect(code).toHaveValue("");
    await page
      .getByRole("textbox", { name: "Server URL" })
      .fill("https://pve.example:8006");
    await page
      .locator("proxmox-connect-view input[type=password]")
      .fill("fixture-password");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(
      page.locator("proxmox-connect-view .status-description")
    ).toContainText("This account requires an authenticator app code.");
    expect(
      await page.evaluate(() =>
        (window as unknown as TotpWindow).totpAttempts.map(
          ({ totp }) => totp ?? null
        )
      )
    ).toEqual([null]);
    expect(
      await page.evaluate(
        () => (window as unknown as TotpWindow).authenticatedCalls
      )
    ).toEqual([]);
  });
});
