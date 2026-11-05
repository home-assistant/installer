import { type Page } from "@playwright/test";
import { approveProxmoxImport, test, expect } from "./fixtures.js";

type CreateVmArgs = { config: { bridge: string; vlan_tag?: number } };

/**
 * Click Install with VM creation held open, as these tests must never create a
 * VM, and return what it was asked to create.
 */
async function captureCreateVmArgs(page: Page): Promise<CreateVmArgs> {
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      isTauri: boolean;
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args: unknown) => Promise<unknown>;
        transformCallback: () => number;
      };
      createArgs?: unknown;
    };
    testWindow.isTauri = true;
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
  const createArgs = () =>
    page.evaluate(
      () => (window as typeof window & { createArgs?: unknown }).createArgs
    );
  await expect.poll(createArgs).toBeDefined();
  return (await createArgs()) as CreateVmArgs;
}

test("retains the chosen bridge and sends it to VM creation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.locator('option-card[heading="Proxmox server"]').click();
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
  await approveProxmoxImport(page);
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
  expect((await captureCreateVmArgs(page)).config.bridge).toBe("vmbr1");
});

test("retains the VLAN tag and sends it to VM creation", async ({ page }) => {
  const width = 390;
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.locator('option-card[heading="Proxmox server"]').click();
  const connection = page.locator("proxmox-connect-view");
  await connection.locator("#server-url").fill("https://pve.example:8006");
  await connection.locator("#username").fill("root@pam");
  await connection.locator("#password").fill("test");
  const next = page.getByRole("button", { name: "Next", exact: true });
  await next.click();
  const configure = page.locator("proxmox-configure-view");
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
  await tag.fill("42");
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
  expect((await captureCreateVmArgs(page)).config.vlan_tag).toBe(42);
});
