import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

type TestWindow = typeof window & {
  isTauri: boolean;
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args: unknown) => Promise<unknown>;
    transformCallback: () => number;
  };
  releaseStorage: () => void;
};

const needsImport =
  "Next is unavailable until a storage on pve accepts Import.";

/**
 * Connect to a server whose node has no storage that accepts Import, and no
 * network bridge unless `bridges`. Its storage and bridges are only answered
 * once the test releases the storage, and enabling Import fails when
 * `enableFails`.
 */
async function connect(
  page: Page,
  { enableFails = false, bridges = true } = {}
) {
  await page.setViewportSize({ width: 800, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.locator('option-card[heading="Proxmox server"]').click();
  await expect(page.locator("proxmox-connect-view")).toBeVisible();
  await page.evaluate(
    ({ enableFails, bridges }) => {
      const win = window as TestWindow;
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      win.releaseStorage = release;
      win.isTauri = true;
      win.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (cmd, args) => {
          switch (cmd) {
            case "log_frontend_event":
              return undefined;
            case "proxmox_certificate_fingerprint":
              return null;
            case "proxmox_connect":
              return {
                server_url: (args as { credentials: { server_url: string } })
                  .credentials.server_url,
                ticket: "fixture",
                csrf_token: "fixture",
              };
            case "proxmox_list_nodes":
              return [{ name: "pve", status: "online" }];
            case "proxmox_get_next_vm_id":
              return 100;
            case "proxmox_list_bridges":
              return bridges
                ? [{ name: "vmbr0", network_type: "bridge", comments: null }]
                : [];
            case "proxmox_list_storage":
              await released;
              return [
                {
                  name: "local",
                  storage_type: "dir",
                  active: true,
                  content: ["backup"],
                  available: 1e11,
                },
                {
                  name: "local-lvm",
                  storage_type: "lvmthin",
                  active: true,
                  content: ["images"],
                  available: 1e11,
                },
              ];
            case "proxmox_enable_storage_import":
              if (enableFails) {
                throw {
                  code: "mock_failure",
                  message: "Permission check failed (/storage/local).",
                  retryable: true,
                  details: {},
                };
              }
              return true;
            default:
              throw new Error(`Unexpected command: ${cmd}`);
          }
        },
      };
    },
    { enableFails, bridges }
  );
  await page.locator("#server-url").fill("https://pve.example:8006");
  await page.locator("#password").fill("fixture");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("proxmox-configure-view")).toBeVisible();
}

/**
 * The audit accessibility-audit.spec.ts runs on every screen, here with the
 * hint showing. Web Awesome's selects name their display input by its title
 * only, which that audit leaves out too; these have an id, so they are told
 * by the input's part.
 */
async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  const violations = results.violations.flatMap(({ id, nodes }) =>
    nodes
      .map((node) => node.target.flat())
      .filter(
        (chain) =>
          id !== "label-title-only" ||
          !chain[chain.length - 1].includes('[part="display-input"]')
      )
      .map((chain) => `${id}: ${chain.join(" > ")}`)
  );
  expect(violations).toEqual([]);
}

const hint = (page: Page, said = needsImport) =>
  page.locator("proxmox-configure-view").getByRole("status").filter({
    hasText: said,
  });

for (const [missing, bridges, said] of [
  ["Import", true, needsImport],
  ["a bridge", false, "Next is unavailable until pve has a network bridge."],
] as const) {
  test(`a lookup that finds no ${missing} says so near Next, while the name is typed`, async ({
    page,
  }) => {
    await connect(page, { bridges });
    const view = page.locator("proxmox-configure-view");
    const name = view.getByRole("textbox", { name: "Display name" });
    await name.focus();
    await page.keyboard.press("End");
    await page.keyboard.type("-ha");
    // The lookup ends halfway through the name
    await page.evaluate(() => (window as TestWindow).releaseStorage());
    await expect(hint(page, said)).toBeVisible();
    await page.keyboard.type("-2");

    await expect(name).toBeFocused();
    await expect(name).toHaveValue("home-assistant-ha-2");
    // Read out politely: nothing took the focus to say it
    await expect(view.locator("[data-focus-alert]")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);

    // Scrolled down to Next, the reason is right above it
    const next = page.getByRole("button", { name: "Next", exact: true });
    await expect(next).toBeDisabled();
    await page.locator("wizard-shell").evaluate((shell) => {
      const content = shell.shadowRoot!.querySelector(".content")!;
      content.scrollTo(0, content.scrollHeight);
    });
    await expect(hint(page, said)).toBeInViewport({ ratio: 1 });
    const hintBox = (await hint(page, said).boundingBox())!;
    const nextBox = (await next.boundingBox())!;
    expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(nextBox.y);
    expect(nextBox.y - (hintBox.y + hintBox.height)).toBeLessThan(120);
    await expectAccessible(page);
  });
}

test("Refresh storage keeps the focus, and says again what Next needs", async ({
  page,
}) => {
  await connect(page);
  await page.evaluate(() => (window as TestWindow).releaseStorage());
  await expect(hint(page)).toBeVisible();

  const refresh = page.getByRole("button", { name: "Refresh storage" });
  await refresh.click();
  await expect(hint(page)).toBeVisible();
  await expect(refresh).toBeFocused();
  await expect(page.locator("[data-focus-alert]")).toHaveCount(0);
});

test("Enable Import that fails takes the focus to say so", async ({ page }) => {
  await connect(page, { enableFails: true });
  await page.evaluate(() => (window as TestWindow).releaseStorage());
  await page
    .getByRole("button", { name: "Enable Import...", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Enable Import", exact: true })
    .click();

  const error = page.locator("proxmox-configure-view [data-focus-alert]");
  await expect(error).toHaveText("Permission check failed (/storage/local).");
  // Once the dialog has closed, as it leaves the rest of the page inert
  await expect(error).toBeFocused();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(hint(page)).toBeVisible();
});
