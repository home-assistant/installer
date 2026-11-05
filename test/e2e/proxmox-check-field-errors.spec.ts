import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

type TestWindow = typeof window & {
  isTauri: boolean;
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args: unknown) => Promise<unknown>;
    transformCallback: () => number;
  };
};

/** Refusals of the check at Next, as the backend sends them */
const refusals = {
  vmId: {
    message_key: "backend.proxmox.vm_id_unavailable",
    message_params: { vm_id: 100 },
  },
  storage: {
    message_key: "backend.proxmox.storage_too_small",
    message_params: { storage: "local-lvm", size_gb: 32, free_gb: 12 },
  },
};

/**
 * Connect at 800×720, where the VM ID and storage are below the fold once
 * scrolled to Next, to a server whose check at Next refuses `refusal` once.
 */
async function connect(page: Page, refusal: keyof typeof refusals) {
  await page.setViewportSize({ width: 800, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.locator('option-card[heading="Proxmox server"]').click();
  await expect(page.locator("proxmox-connect-view")).toBeVisible();
  await page.evaluate((details) => {
    const win = window as TestWindow;
    let refused = false;
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
            return [{ name: "vmbr0", network_type: "bridge", comments: null }];
          case "proxmox_list_storage":
            return [
              {
                name: "local",
                storage_type: "dir",
                active: true,
                content: ["import"],
                available: 1e11,
              },
              {
                name: "local-lvm",
                storage_type: "lvmthin",
                active: true,
                content: ["images"],
                available: 12 * 1024 ** 3,
              },
            ];
          case "proxmox_check_vm_config":
            if (refused) return null;
            refused = true;
            throw {
              code: "proxmox_action_required",
              message: "English from the backend",
              retryable: false,
              details,
            };
          default:
            throw new Error(`Unexpected command: ${cmd}`);
        }
      },
    };
  }, refusals[refusal]);
  await page.locator("#server-url").fill("https://pve.example:8006");
  await page.locator("#password").fill("fixture");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("proxmox-configure-view")).toBeVisible();
}

/** Scroll down to Next, as someone who reached it would be, and press it */
async function pressNext(page: Page) {
  await page.locator("wizard-shell").evaluate((shell) => {
    const content = shell.shadowRoot!.querySelector(".content")!;
    content.scrollTo(0, content.scrollHeight);
  });
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeEnabled();
  await next.click();
}

/**
 * The audit accessibility-audit.spec.ts runs on every screen, here with a
 * field's error showing. Web Awesome's selects name their display input by
 * its title only, which that audit leaves out too.
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

test("a VM ID Proxmox can't use is said at the VM ID, which takes the focus", async ({
  page,
}) => {
  await connect(page, "vmId");
  await pressNext(page);

  const view = page.locator("proxmox-configure-view");
  const vmId = view.getByRole("spinbutton", { name: "VM ID" });
  const taken = "VM ID 100 can't be used. Choose a different ID.";
  await expect(vmId).toBeFocused();
  await expect(vmId).toBeInViewport({ ratio: 1 });
  await expect(vmId).toHaveAttribute("aria-invalid", "true");
  await expect(vmId).toHaveAccessibleDescription(taken);
  // Said once, at the field
  await expect(view.locator("[data-focus-alert]")).toHaveCount(0);
  await expectAccessible(page);

  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("101");
  await expect(vmId).toHaveAttribute("aria-invalid", "false");
  await expect(vmId).toHaveAccessibleDescription(
    "Unique identifier for the virtual machine"
  );
  await pressNext(page);
  await expect(page.locator("proxmox-confirm-view")).toBeVisible();
});

test("storage that is too small is said at the storage, which takes the focus", async ({
  page,
}) => {
  await connect(page, "storage");
  await pressNext(page);

  const view = page.locator("proxmox-configure-view");
  const storage = view.getByRole("combobox", { name: "Storage" });
  const tooSmall =
    'Not enough free space on "local-lvm" for the 32 GB disk (12 GB free).';
  await expect(storage).toBeFocused();
  await expect(storage).toBeInViewport({ ratio: 1 });
  await expect(storage).toHaveAttribute("aria-invalid", "true");
  await expect(storage).toHaveAccessibleDescription(tooSmall);
  await expect(view.locator("[data-focus-alert]")).toHaveCount(0);
  await expectAccessible(page);
});
