import { test, expect } from "@playwright/test";
import { approveProxmoxImport } from "./fixtures.js";

for (const width of [1100, 390]) {
  test(`optional VLAN validation and persistence at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.locator("welcome-view wa-button").click();
    await page.locator('option-card[title="Proxmox server"]').click();
    const connection = page.locator("proxmox-connect-view");
    await connection.locator("#server-url").fill("https://pve.example:8006");
    await connection.locator("#username").fill("root@pam");
    await connection.locator("#password").fill("test");
    const next = page.getByRole("button", { name: "Next", exact: true });
    await next.click();
    const configure = page.locator("proxmox-configure-view");
    const bridgeSelect = configure.getByRole("combobox", {
      name: "Network bridge",
      exact: true,
    });
    // The mock offers a VLAN-aware vmbr0 first and a plain vmbr1 last
    const chooseBridge = async (key: "Home" | "End", name: string) => {
      await bridgeSelect.focus();
      await page.keyboard.press("Space");
      await page.keyboard.press(key);
      await page.keyboard.press("Enter");
      await expect(bridgeSelect).toHaveAttribute("aria-expanded", "false");
      await expect(configure.locator("#network-bridge")).toHaveJSProperty(
        "value",
        name
      );
    };
    await expect(configure.locator("#network-bridge")).toHaveJSProperty(
      "value",
      "vmbr0"
    );
    await expect(configure.locator("wa-details")).not.toHaveAttribute("open");
    // The browser mock starts without Import storage, like a fresh Proxmox
    await approveProxmoxImport(page);
    await next.click();
    await expect(page.locator("proxmox-confirm-view")).not.toContainText(
      "VLAN tag:"
    );
    await page.locator("wizard-shell .header wa-button").click();
    await configure
      .getByRole("button", { name: "Advanced", exact: true })
      .click();
    const tag = configure.locator("#vlan-tag input");
    for (const value of ["0", "4095", "1.5", "-1", "abc", "1e2"]) {
      await tag.fill(value);
      await expect(next).toBeDisabled();
      await expect(configure.getByRole("alert")).toContainText("whole number");
    }
    for (const value of ["1", "4094", ""]) {
      await tag.fill(value);
      await expect(next).toBeEnabled();
    }
    await tag.fill("42");
    await chooseBridge("End", "vmbr1");
    await expect(next).toBeDisabled();
    await expect(configure.getByRole("alert")).toContainText(
      "VLAN-aware bridge"
    );
    await configure.locator("wa-details").screenshot({
      path: test.info().outputPath(`vlan-validation-${width}.png`),
    });
    await chooseBridge("Home", "vmbr0");
    await next.click();
    await expect(page.locator("proxmox-confirm-view")).toContainText(
      "VLAN tag: 42"
    );
    await page.locator("proxmox-confirm-view").screenshot({
      path: test.info().outputPath(`vlan-confirmation-${width}.png`),
    });
    await page.locator("wizard-shell .header wa-button").click();
    await expect(tag).toHaveValue("42");
    await expect(configure.locator("wa-details")).toHaveAttribute("open");
    await expect(next).toBeEnabled();
    await configure.locator("wa-details").scrollIntoViewIfNeeded();
    await configure.locator("wa-details").screenshot({
      path: test.info().outputPath(`vlan-${width}.png`),
    });
    const bounds = await configure.locator("wa-details").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await next.click();
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
                createArgs?: { config: { vlan_tag?: number } };
              }
            ).createArgs?.config.vlan_tag
        )
      )
      .toBe(42);
  });
}
