import { test, expect } from "./fixtures.js";

type TestWindow = typeof window & {
  isTauri: boolean;
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args: unknown) => Promise<unknown>;
  };
  connections: { server_url: string; totp?: string | null }[];
};

// An account with two-factor authentication: Proxmox asks for the code once
// the password is right, and the code goes on its own field
test("asks for the authenticator code on its field, for an address copied from the web interface", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.locator('option-card[heading="Proxmox server"]').click();
  await expect(page.locator("proxmox-connect-view")).toBeVisible();
  await page.evaluate(() => {
    const testWindow = window as TestWindow;
    testWindow.isTauri = true;
    testWindow.connections = [];
    testWindow.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        if (cmd === "log_frontend_event") return;
        // A trusted certificate: no confirmation before the login
        if (cmd === "proxmox_certificate_fingerprint") return null;
        if (cmd === "proxmox_connect") {
          const { credentials } = args as {
            credentials: { server_url: string; totp?: string | null };
          };
          testWindow.connections.push({
            server_url: credentials.server_url,
            totp: credentials.totp,
          });
          if (!credentials.totp) {
            throw {
              code: "proxmox_two_factor",
              message:
                "This account requires an authenticator app code. Enter the current code and try again.",
              retryable: false,
              details: {
                message_key: "backend.proxmox.two_factor_code_required",
                message_params: {},
              },
            };
          }
          return {
            server_url: credentials.server_url,
            ticket: "fixture",
            csrf_token: "fixture",
          };
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

  const serverUrl = page.getByRole("textbox", { name: "Server URL" });
  await serverUrl.fill("https://pve.example:8006/#v1:0:=qemu%2F100:4:::::::");
  const password = page.locator("proxmox-connect-view input[type=password]");
  await password.fill("fixture-password");
  await password.press("Enter");

  const code = page.getByRole("textbox", {
    name: "Authenticator app code",
    exact: true,
  });
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.locator('proxmox-connect-view wa-input[input-id="totp"]')
  ).toContainText("This account requires an authenticator app code.");
  // Nothing above the form: the field says it
  await expect(page.locator("proxmox-connect-view .status-row")).toHaveCount(0);
  await expect(serverUrl).toHaveValue("https://pve.example:8006");

  await code.fill("123456");
  await code.press("Enter");
  await expect(page.locator("proxmox-configure-view")).toBeVisible();
  expect(await page.evaluate(() => (window as TestWindow).connections)).toEqual(
    [
      { server_url: "https://pve.example:8006", totp: undefined },
      { server_url: "https://pve.example:8006", totp: "123456" },
    ]
  );
});
