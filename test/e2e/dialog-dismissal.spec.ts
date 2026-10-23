import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

// A dialog closed with one of its buttons animates out, as it does after
// Escape. It still takes clicks while it does, but reports only the first way
// out. Every dialog reports its main action as dialog-primary, and any other
// way out as dialog-secondary. With reduced motion, every dialog appears and
// goes at once.

const dialogs = [
  { tag: "info-dialog", action: "OK" },
  { tag: "confirm-dialog", action: "Erase and install" },
] as const;

type Events = { dialogEvents: string[] };

/** Show `tag` on a page of its own, recording the events it reports. */
async function open(page: Page, tag: string) {
  await page.goto("/");
  await page.locator("welcome-view").waitFor({ state: "attached" });
  await page.evaluate((tag) => {
    document.querySelector("app-shell")!.remove();
    const dialog = document.createElement(tag) as HTMLElement & {
      open: boolean;
    };
    const events: string[] = [];
    (window as unknown as Events).dialogEvents = events;
    for (const type of ["dialog-primary", "dialog-secondary"])
      dialog.addEventListener(type, () => events.push(type));
    dialog.open = true;
    document.body.append(dialog);
  }, tag);
  await expect(page.getByRole("dialog")).toBeVisible();
  // Long enough to see it animate out, and to click during it
  await page
    .locator(`${tag} wa-dialog`)
    .evaluate((dialog: HTMLElement) =>
      dialog.style.setProperty("--hide-duration", "1s")
    );
}

const events = (page: Page) =>
  page.evaluate(() => (window as unknown as Events).dialogEvents);

for (const { tag, action } of dialogs) {
  test(`${tag} animates out after a button, as after Escape`, async ({
    page,
  }) => {
    await open(page, tag);
    await page.getByRole("button", { name: action, exact: true }).click();

    const dialog = page.locator(`${tag} dialog`);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveClass(/\bhide\b/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(tag)).toBeHidden();
    expect(await events(page)).toEqual(["dialog-primary"]);
  });

  test(`${tag} reports one choice for a double click`, async ({ page }) => {
    await open(page, tag);
    await page.getByRole("button", { name: action, exact: true }).dblclick();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await events(page)).toEqual(["dialog-primary"]);
  });

  test(`${tag} reports Escape, not a click while it animates out`, async ({
    page,
  }) => {
    await open(page, tag);
    await page.keyboard.press("Escape");
    await expect(page.locator(`${tag} dialog`)).toHaveClass(/\bhide\b/);
    // It shrinks while it goes, so it never holds still for a normal click
    await page
      .getByRole("button", { name: action, exact: true })
      .click({ force: true });

    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await events(page)).toEqual(["dialog-secondary"]);
  });
}

test.describe("with reduced motion", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  /**
   * The animations `dialog` runs from now on. The backdrop only fades, and
   * WebKit reports its animation without naming the pseudo-element.
   */
  async function recordAnimations(dialog: Locator) {
    await dialog.evaluate((dialog) => {
      const started: string[] = [];
      (window as unknown as { started: string[] }).started = started;
      dialog.addEventListener("animationstart", (event) => {
        const { animationName } = event as AnimationEvent;
        if (animationName !== "show-backdrop") started.push(animationName);
      });
    });
    return () =>
      dialog.evaluate(
        () => (window as unknown as { started: string[] }).started
      );
  }

  for (const { tag } of dialogs) {
    test(`${tag} appears and goes without animating`, async ({ page }) => {
      await page.goto("/");
      await page.locator("welcome-view").waitFor({ state: "attached" });
      await page.evaluate((tag) => {
        document.querySelector("app-shell")!.remove();
        document.body.append(document.createElement(tag));
      }, tag);
      const animations = await recordAnimations(page.locator(`${tag} dialog`));

      await page.locator(tag).evaluate((dialog) => {
        (dialog as HTMLElement & { open: boolean }).open = true;
      });
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await animations()).toEqual([]);
    });
  }

  test("the diagnostics dialog appears and goes without animating", async ({
    page,
  }) => {
    await page.goto("/");
    const animations = await recordAnimations(
      page.locator("welcome-view diagnostics-actions dialog")
    );

    await page
      .getByRole("button", { name: "Report a problem", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await animations()).toEqual([]);
  });

  test("the certificate dialog appears and goes without animating", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Let's go" }).click();
    await page.locator('option-card[heading="Proxmox server"]').click();
    await expect(page.locator("proxmox-connect-view")).toBeVisible();
    await page.evaluate(() => {
      const win = window as unknown as {
        isTauri: boolean;
        __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> };
      };
      win.isTauri = true;
      win.__TAURI_INTERNALS__ = {
        invoke: async (cmd) => {
          if (cmd === "proxmox_certificate_fingerprint")
            return Array(32).fill("AB").join(":");
          if (cmd === "log_frontend_event") return;
          return new Promise(() => {});
        },
      };
    });
    const animations = await recordAnimations(
      page.locator("proxmox-connect-view dialog")
    );

    await page
      .getByRole("textbox", { name: "Server URL" })
      .fill("https://pve.example:8006");
    await page
      .locator("proxmox-connect-view input[type=password]")
      .fill("fixture-password");
    await page
      .locator("proxmox-connect-view input[type=password]")
      .press("Enter");
    await expect(
      page.getByRole("dialog", { name: "Trust this Proxmox server?" })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await animations()).toEqual([]);
  });
});
