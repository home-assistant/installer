import { test, expect } from "@playwright/test";

test("holds Next until a restored bridge is verified for the current session", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("welcome-view wa-button").click();
  await page.locator('option-card[title="Proxmox server"]').click();
  await page
    .getByLabel("Server URL", { exact: true })
    .fill("https://pve.example:8006");
  await page.getByLabel("Password", { exact: true }).fill("test");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.locator('wa-select[label="Network bridge"]')
  ).toHaveJSProperty("value", "vmbr0");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __TAURI__: object;
      __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> };
      resolveBridges?: () => void;
    };
    testWindow.__TAURI__ = {};
    testWindow.__TAURI_INTERNALS__ = {
      invoke: async (cmd) => {
        if (cmd === "proxmox_list_nodes")
          return [{ name: "pve", status: "online" }];
        if (cmd === "proxmox_get_next_vm_id") return 100;
        if (cmd === "proxmox_list_storage")
          return [
            {
              name: "local",
              active: true,
              content: ["images"],
              available: 100,
            },
          ];
        if (cmd === "proxmox_list_bridges")
          return new Promise((resolve) => {
            testWindow.resolveBridges = () =>
              resolve([
                { name: "vmbr0", network_type: "bridge", comments: null },
              ]);
          });
        throw new Error(`Unexpected command: ${cmd}`);
      },
    };
  });
  await page.locator("wizard-shell .header wa-button").click();
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeDisabled();
  await expect(page.getByText("Loading network bridges...")).toBeVisible();
  await page.evaluate(() =>
    (window as typeof window & { resolveBridges: () => void }).resolveBridges()
  );
  await expect(next).toBeEnabled();
});

test("retains the chosen bridge and sends it to VM creation", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("welcome-view wa-button").click();
  await page.locator('option-card[title="Proxmox server"]').click();
  const connection = page.locator("proxmox-connect-view");
  await connection.locator("#server-url").fill("https://pve.example:8006");
  await connection.locator("#username").fill("root@pam");
  await connection.locator("#password").fill("test");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const configure = page.locator("proxmox-configure-view");
  await expect(configure.locator("#network-bridge")).toHaveJSProperty(
    "value",
    "vmbr0"
  );
  // Keyboard selection, like the other Web Awesome selects, works in WebKit too
  const bridgeSelect = configure.getByRole("combobox", {
    name: "Network bridge",
    exact: true,
  });
  await bridgeSelect.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(bridgeSelect).toHaveAttribute("aria-expanded", "false");
  await expect(configure.locator("#network-bridge")).toHaveJSProperty(
    "value",
    "vmbr1"
  );
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("proxmox-confirm-view")).toContainText(
    "Network bridge: vmbr1"
  );
  await page.locator("wizard-shell .header wa-button").click();
  await expect(
    configure.locator('wa-select[label="Network bridge"]')
  ).toHaveJSProperty("value", "vmbr1");
  await expect(
    page.getByRole("button", { name: "Next", exact: true })
  ).toBeEnabled();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  // Hold the native create command open; this test must never create a VM.
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __TAURI__: object;
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args: unknown) => Promise<unknown>;
        transformCallback: () => number;
      };
      createArgs?: unknown;
    };
    testWindow.__TAURI__ = {};
    testWindow.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (cmd, args) => {
        if (cmd !== "proxmox_create_vm")
          throw new Error(`Unexpected command: ${cmd}`);
        testWindow.createArgs = args;
        return new Promise(() => {});
      },
    };
  });
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              createArgs?: { config: { bridge: string } };
            }
          ).createArgs?.config.bridge
      )
    )
    .toBe("vmbr1");
});
