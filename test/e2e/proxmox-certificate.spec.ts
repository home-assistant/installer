import { test, expect } from "@playwright/test";

for (const width of [1100, 390]) {
  test(`certificate approval precedes authentication at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto("/");
    await page.locator("welcome-view wa-button").click();
    await page.locator('option-card[title="Proxmox server"]').click();
    await expect(page.locator("proxmox-connect-view")).toBeVisible();
    await page.evaluate(() => {
      const win = window as unknown as {
        __TAURI__: object;
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args: unknown) => Promise<unknown>;
        };
        certificateCalls: string[];
      };
      win.__TAURI__ = {};
      win.certificateCalls = [];
      win.__TAURI_INTERNALS__ = {
        invoke: async (cmd, args) => {
          if (cmd === "log_frontend_event") return;
          win.certificateCalls.push(cmd);
          if (cmd === "proxmox_certificate_fingerprint")
            return Array(32).fill("AB").join(":");
          if (cmd === "proxmox_connect") {
            const { credentials } = args as {
              credentials: { certificate_sha256: string };
            };
            if (
              credentials.certificate_sha256 !== Array(32).fill("AB").join(":")
            )
              throw new Error("Missing approved pin");
            return {
              server_url: "https://pve.example:8006",
              ticket: "fixture",
              csrf_token: "fixture",
              certificate_sha256: credentials.certificate_sha256,
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
    await page
      .getByRole("textbox", { name: "Server URL" })
      .fill("https://pve.example:8006");
    await page
      .locator("proxmox-connect-view input[type=password]")
      .fill("fixture-password");
    await page
      .locator("proxmox-connect-view input[type=password]")
      .press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Trust this Proxmox server?",
    });
    await expect(dialog).toBeVisible();
    // The explanation and fingerprint are slotted into wa-dialog
    await expect(page.locator("proxmox-connect-view wa-dialog")).toContainText(
      Array(32).fill("AB").join(":")
    );
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { certificateCalls: string[] }).certificateCalls
      )
    ).toEqual(["proxmox_certificate_fingerprint"]);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.locator("proxmox-connect-view")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { certificateCalls: string[] }).certificateCalls
      )
    ).toEqual(["proxmox_certificate_fingerprint"]);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.getByRole("button", { name: "Trust and connect" }).click();
    await expect(page.locator("proxmox-configure-view")).toBeVisible();
    await page.getByRole("button", { name: /Back/ }).click();
    await expect(page.locator("proxmox-connect-view")).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator("proxmox-configure-view")).toBeVisible();
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { certificateCalls: string[] }
        ).certificateCalls.filter(
          (cmd) =>
            cmd === "proxmox_certificate_fingerprint" ||
            cmd === "proxmox_connect"
        )
      )
    ).toEqual([
      "proxmox_certificate_fingerprint",
      "proxmox_certificate_fingerprint",
      "proxmox_connect",
    ]);
  });
}
