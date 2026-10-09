import { expect, test } from "@playwright/test";

for (const [flow, tag, flag] of [
  ["sbc", "progress-view", "_flashError"],
  ["proxmox", "proxmox-progress-view", "_proxmoxInstallError"],
  ["vm", "utm-progress-view", "_utmInstallError"],
] as const) {
  test(`${flow} footer retry restores the installation heading focus`, async ({
    page,
  }) => {
    await page.goto("/");
    // The app shell loads after locale detection, so wait for it to render.
    await page.locator("welcome-view").waitFor({ state: "attached" });
    await page.evaluate(
      async ({ flow, tag, flag }) => {
        const statePath = "/src/state/wizard-state.ts";
        const { wizardState } = (await import(
          statePath
        )) as typeof import("../../src/state/wizard-state.js");
        const prototype = customElements.get(tag)!.prototype;
        // Never start an installation: exercise the real retry/render path only.
        prototype._startFlashing = prototype._startInstall = async () => {};
        const app = document.querySelector(
          "app-shell"
        )! as unknown as HTMLElement & {
          _currentView: string;
          _installRetryable: boolean;
          updateComplete: Promise<unknown>;
        } & Record<typeof flag, boolean>;
        wizardState.startFlow(flow);
        wizardState.goToStep(3);
        app._currentView = "wizard";
        await app.updateComplete;
        const progress = app.shadowRoot!.querySelector(
          tag
        )! as unknown as HTMLElement & {
          _error: unknown;
          updateComplete: Promise<unknown>;
        };
        progress._error = {
          code: "test_failure",
          message: "Test failure",
          retryable: true,
          details: {},
        };
        app[flag] = true;
        // The shell only offers Try again for a retryable failure
        app._installRetryable = true;
        await progress.updateComplete;
      },
      { flow, tag, flag }
    );
    await expect(page.getByRole("alert")).toBeFocused();
    await page.getByRole("button", { name: "Try again", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(`${tag} h2`)).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Try again", exact: true })
    ).toHaveCount(0);
  });
}

for (const tag of ["confirm-dialog", "info-dialog"]) {
  test(`${tag} suppresses its inner dialog animation with reduced motion`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.locator("welcome-view").waitFor({ state: "attached" });
    await page.evaluate((tag) => {
      document.querySelector("app-shell")!.remove();
      const dialog = document.createElement(tag) as HTMLElement & {
        open: boolean;
      };
      dialog.open = true;
      document.body.append(dialog);
    }, tag);
    await expect(page.locator(`${tag} dialog`)).toBeVisible();
    await expect(page.locator(`${tag} dialog`)).toHaveCSS(
      "animation-name",
      "none"
    );
  });
}

for (const tag of [
  "success-view",
  "proxmox-success-view",
  "utm-success-view",
]) {
  test(`${tag} preserves next-step list and completion semantics`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.locator("welcome-view").waitFor({ state: "attached" });
    await page.evaluate((tag) => {
      document.querySelector("app-shell")!.remove();
      document.body.append(document.createElement(tag));
    }, tag);
    const heading = page.getByRole("heading", { name: "You're all set!" });
    await expect(heading).toBeFocused();
    await expect(page.getByRole("alert")).toContainText("You're all set!");
    const list = page.getByRole("list", { name: "Next steps" });
    await expect(list).toBeVisible();
    expect(await list.getByRole("listitem").count()).toBeGreaterThan(0);
    expect(await list.ariaSnapshot()).toContain("listitem");
    await expect
      .poll(() =>
        page
          .locator(`${tag} svg`)
          .first()
          .evaluate((svg) => (svg as SVGSVGElement).animationsPaused())
      )
      .toBe(true);
  });
}

test("reduced motion reaches card shadow roots and the FAB button part", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.locator("welcome-view").waitFor({ state: "attached" });
  await page.evaluate(() => {
    document.querySelector("app-shell")!.remove();
    for (const tag of [
      "option-card",
      "device-card",
      "drive-card",
      "fab-button",
    ]) {
      const element = document.createElement(tag);
      element.setAttribute("title", "Test option");
      element.setAttribute("name", "Test device");
      element.setAttribute("label", "Refresh devices");
      document.body.append(element);
    }
  });
  for (const tag of ["option-card", "device-card", "drive-card"]) {
    const card = page.locator(`${tag} .card`);
    await card.hover();
    await expect(card).toHaveCSS("transition-duration", "0s");
    await page.mouse.down();
    await expect(card).toHaveCSS("transform", "none");
    await page.mouse.up();
  }
  const button = page.locator("fab-button wa-button");
  await button.hover();
  await expect(button).toHaveCSS("transition-duration", "0s");
  await expect(button).toHaveCSS("transform", "none");
  await expect(button.locator("button")).toHaveCSS("transition-duration", "0s");
  await page.mouse.down();
  await expect(button).toHaveCSS("transform", "none");
  await page.mouse.up();
});

test("navigation focuses headings without stealing focus on input", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await expect(
    page.getByRole("heading", { name: "What would you like to install on?" })
  ).toBeFocused();
  await page.getByRole("button", { name: "Proxmox server" }).click();
  await expect(
    page.getByRole("heading", { name: "Connect to Proxmox VE" })
  ).toBeFocused();
  await expect(page.locator('[aria-current="step"]')).toHaveText(
    "Connect to Proxmox"
  );
  const url = page.getByRole("textbox", { name: "Server URL" });
  await url.fill("http://pve.test:8006");
  await expect(url).toBeFocused();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const error = page.getByRole("alert");
  await expect(error).toContainText("fill in all fields");
  await expect(error).toBeFocused();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(error).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("desktop-error.png") });
  await page.keyboard.press("Tab");
  await expect(url).toBeFocused();
  await url.fill("https://pve.test:8006");
  await page
    .getByRole("textbox", { name: "Password", exact: true })
    .fill("mock-password");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Configure virtual machine" })
  ).toBeFocused();
  const name = page
    .locator("proxmox-configure-view")
    .getByRole("textbox", { name: "Display name" });
  await name.fill("my-home");
  await expect(name).toBeFocused();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ready to install" })
  ).toBeFocused();
  await page.getByRole("button", { name: "Back", exact: false }).click();
  await expect(
    page.getByRole("heading", { name: "Configure virtual machine" })
  ).toBeFocused();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Home Assistant" })
  ).toBeFocused();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`${colorScheme} theme text contrast and reduced motion`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.locator(".logo-container").hover();
    await expect(page.locator(".logo:visible")).toHaveCSS(
      "animation-name",
      "none"
    );
    const ratios = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      function luminance(hex: string) {
        const values = hex
          .trim()
          .slice(1)
          .match(/../g)!
          .map((part) => parseInt(part, 16) / 255)
          .map((v) =>
            v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
          );
        return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
      }
      function contrast(a: string, b: string) {
        const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (values[0] + 0.05) / (values[1] + 0.05);
      }
      const token = (name: string) => styles.getPropertyValue(name);
      return [
        contrast(token("--ha-primary-fill"), "#ffffff"),
        contrast(token("--ha-primary-color"), token("--ha-background-color")),
        contrast(token("--ha-error-color"), token("--ha-background-color")),
        contrast(token("--ha-error-color"), token("--ha-card-background")),
        contrast(token("--ha-primary-color-dark"), "#18bcf2"),
      ];
    });
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    await page.getByRole("button", { name: "Let's go" }).click();
    await page.getByRole("button", { name: "Proxmox server" }).click();
    const indicator = page.locator("step-indicator");
    const box = await indicator.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await expect(indicator.getByRole("listitem")).toHaveCount(5);
    await expect(indicator.locator(".step-dot").first()).toHaveCSS(
      "transition-duration",
      "0s"
    );
    await expect(indicator.locator('[aria-current="step"]')).toHaveText(
      "Connect to Proxmox"
    );
    await page.screenshot({
      path: testInfo.outputPath(`mobile-${colorScheme}.png`),
    });
  });
}

for (const tag of [
  "progress-view",
  "proxmox-progress-view",
  "utm-progress-view",
]) {
  test(`${tag} keeps stage semantics and progress with reduced motion`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.locator("welcome-view").waitFor({ state: "attached" });
    const initialStatus = await page.evaluate(async (tag) => {
      document.querySelector("app-shell")!.remove();
      const progress = document.createElement(tag) as HTMLElement & {
        _startFlashing: () => Promise<void>;
        _startInstall: () => Promise<void>;
        _progress: unknown;
        _stage: string;
        _bytesProcessed: number;
        _totalBytes: number;
        updateComplete: Promise<unknown>;
      };
      // Isolated rendered view: never begin an install or call native commands.
      progress._startFlashing = progress._startInstall = async () => {};
      progress.style.height = "100vh";
      progress._stage = "downloading";
      progress._progress =
        tag === "progress-view"
          ? {
              stage: "downloading",
              progress: 25,
              bytes_processed: 256,
              total_bytes: 1024,
            }
          : 25;
      progress._bytesProcessed = 256;
      progress._totalBytes = 1024;
      document.body.append(progress);
      await progress.updateComplete;
      // The shared progress layout renders the live region in its own shadow root
      const layout = progress.shadowRoot!.querySelector(
        "install-progress"
      )! as HTMLElement & { updateComplete: Promise<unknown> };
      await layout.updateComplete;
      await new Promise(requestAnimationFrame);
      return layout
        .shadowRoot!.querySelector('[role="status"]')!
        .textContent?.trim();
    }, tag);
    expect(initialStatus).toBe("");
    await expect(page.getByRole("status")).toHaveText("Downloading");
    await expect(
      page.getByRole("list", { name: "Installation stages" })
    ).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveCount(
      {
        "progress-view": 5,
        "proxmox-progress-view": 8,
        "utm-progress-view": 7,
      }[tag]!
    );
    // Stage labels are each flow's own descriptions in the shared layout
    await expect(page.locator('[aria-current="step"]')).toContainText(
      tag === "progress-view" ? "Fetching the Home Assistant image" : "Download"
    );
    // The supplied Casita artwork is a static image, so it has no SVG
    // animations left to pause
    await expect(page.locator(`${tag} casita-mascot img`)).toBeVisible();
    expect(await page.locator(`${tag} svg animate`).count()).toBe(0);
    await expect(page.locator(".stage-dot.active")).toHaveCSS(
      "animation-name",
      "none"
    );
    await expect(page.locator(".stage-dot.active")).toHaveCSS(
      "background-color",
      "rgb(0, 103, 135)"
    );
    await expect(page.locator(".cloud-text")).toHaveCSS(
      "color",
      "rgb(0, 65, 86)"
    );
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "25"
    );
    await page.screenshot({
      path: testInfo.outputPath(`${tag}-reduced-motion.png`),
    });
    await page.evaluate((tag) => {
      (
        document.querySelector(tag) as HTMLElement & { _error: unknown }
      )._error = {
        code: "drive_disconnected",
        message: "Mock drive disconnected",
        retryable: false,
        details: {},
      };
    }, tag);
    await expect(page.getByRole("alert")).toBeFocused();
    await expect(
      page.locator(`${tag} casita-mascot[mood="problem"] img`)
    ).toBeVisible();
  });
}

test("disk installation keeps heading focus after the confirmation dialog closes", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .getByRole("button", { name: "Raspberry Pi & other boards" })
    .click();
  await page
    .getByRole("radio", { name: "Raspberry Pi 5", exact: true })
    .click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("radio").first().click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await page
    .getByRole("button", { name: "Erase and install", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.locator("progress-view").getByRole("heading")
  ).toBeFocused();
  await expect(
    page
      .locator("success-view")
      .getByRole("heading", { name: "You're all set!" })
  ).toBeFocused({ timeout: 20000 });
  await expect(page.locator("success-view").getByRole("alert")).toContainText(
    "You're all set!"
  );
});
