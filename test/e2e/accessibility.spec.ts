import {
  approveProxmoxImport,
  skipWifiStep,
  expect,
  test,
} from "./fixtures.js";

// sRGB channels (0 to 1) of a computed colour, rgb() or color(srgb …), painted
// over an opaque background
function paint(color: string, background = [1, 1, 1]) {
  const [r, g, b, alpha = 1] = color.match(/[\d.]+/g)!.map(Number);
  // rgb() counts to 255, color(srgb …) to 1
  const scale = color.startsWith("color(") ? 1 : 255;
  return [r, g, b].map(
    (value, i) => (value / scale) * alpha + background[i] * (1 - alpha)
  );
}

function luminance(rgb: number[]) {
  const [r, g, b] = rgb.map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  );
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

// WCAG contrast of a colour drawn over layers listed from the top down, so a
// translucent hover or selection fill is blended with what is under it
function contrast(foreground: string, ...backgrounds: string[]) {
  const base = backgrounds.reduceRight(
    (under, color) => paint(color, under),
    [1, 1, 1]
  );
  const values = [luminance(paint(foreground, base)), luminance(base)].sort(
    (a, b) => b - a
  );
  return (values[0] + 0.05) / (values[1] + 0.05);
}

for (const [flow, tag] of [
  ["sbc", "progress-view"],
  ["proxmox", "proxmox-progress-view"],
  ["vm", "utm-progress-view"],
] as const) {
  test(`${flow} footer retry restores the installation heading focus`, async ({
    page,
  }) => {
    await page.goto("/");
    // The app shell loads after locale detection, so wait for it to render.
    await page.locator("welcome-view").waitFor({ state: "attached" });
    await page.evaluate(
      async ({ flow, tag }) => {
        const statePath = "/src/state/wizard-state.ts";
        const { wizardState } = (await import(
          statePath
        )) as typeof import("../../src/state/wizard-state.js");
        const prototype = customElements.get(tag)!.prototype;
        // Never start an installation: exercise the real retry/render path only.
        prototype._startInstall = async () => {};
        const app = document.querySelector(
          "app-shell"
        )! as unknown as HTMLElement & {
          _currentView: string;
          _installError: boolean;
          _installRetryable: boolean;
          updateComplete: Promise<unknown>;
        };
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
        app._installError = true;
        // The shell only offers Try again for a retryable failure
        app._installRetryable = true;
        await progress.updateComplete;
      },
      { flow, tag }
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

test("reduced motion reaches card shadow roots", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.locator("welcome-view").waitFor({ state: "attached" });
  await page.evaluate(() => {
    document.querySelector("app-shell")!.remove();
    for (const tag of ["option-card", "device-card", "drive-card"]) {
      const element = document.createElement(tag);
      element.setAttribute("heading", "Test option");
      element.setAttribute("name", "Test device");
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
});

test("indeterminate progress and the spinner hold still with reduced motion", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.locator("welcome-view").waitFor({ state: "attached" });
  await page.evaluate(() => {
    document.querySelector("app-shell")!.remove();
    const bar = Object.assign(document.createElement("progress-bar"), {
      indeterminate: true,
      label: "Waiting for Home Assistant",
    });
    document.body.append(bar, document.createElement("loading-spinner"));
  });
  const progressbar = page.getByRole("progressbar", {
    name: "Waiting for Home Assistant",
  });
  // Its value is unknown, not 0%
  await expect(progressbar).not.toHaveAttribute("aria-valuenow");
  const indicator = page.locator("progress-bar .indicator");
  await expect(indicator).toHaveCSS("animation-name", "none");
  // It fills the track: half of it, standing still, would read as 50%
  const track = (await progressbar.boundingBox())!;
  const fill = (await indicator.boundingBox())!;
  expect([fill.x, fill.width]).toEqual([track.x, track.width]);
  await page.locator("progress-bar").screenshot({
    path: testInfo.outputPath("indeterminate-reduced-motion.png"),
  });
  const spinner = page.locator("loading-spinner");
  await expect(spinner.locator("svg")).toHaveCSS("animation-name", "none");
  await expect(spinner.locator(".indicator")).toHaveCSS(
    "animation-name",
    "none"
  );

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(indicator).toHaveCSS(
    "animation-name",
    "wa-progress-indeterminate"
  );
  await expect(spinner.locator(".indicator")).toHaveCSS(
    "animation-name",
    "dash"
  );
});

test("Proxmox advanced settings expand without animating with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.getByRole("button", { name: "Proxmox server" }).click();
  await page
    .getByRole("textbox", { name: "Server URL" })
    .fill("https://pve.test:8006");
  await page
    .getByRole("textbox", { name: "Password", exact: true })
    .fill("mock-password");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const details = page.locator("proxmox-configure-view wa-details");
  // Web Awesome reads these off its body to time the expand and collapse
  expect(
    await details
      .locator(".body")
      .evaluate((body) =>
        ["--show-duration", "--hide-duration"].map((name) =>
          getComputedStyle(body).getPropertyValue(name).trim()
        )
      )
  ).toEqual(["0s", "0s"]);
  await expect(details.locator('[part~="icon"]')).toHaveCSS(
    "transition-duration",
    "0s"
  );
  await details.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(page.locator("#vlan-tag")).toBeVisible();
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
  // Each field says what is wrong with it, and Next goes to the first one
  const password = page.getByRole("textbox", { name: "Password", exact: true });
  await expect(url).toBeFocused();
  await expect(url).toHaveAttribute("aria-invalid", "true");
  await expect(url).toHaveAccessibleDescription(/must use HTTPS/);
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(password).toHaveAccessibleDescription("Enter the password");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(url).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("desktop-error.png") });
  await url.fill("https://pve.test:8006");
  await expect(url).toHaveAttribute("aria-invalid", "false");
  await password.fill("mock-password");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Configure virtual machine" })
  ).toBeFocused();
  await approveProxmoxImport(page);
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
    page.getByRole("heading", { name: "What would you like to install on?" })
  ).toBeFocused();
});

test("connecting to Proxmox keeps the focus and says so", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.getByRole("button", { name: "Proxmox server" }).click();
  await page
    .getByRole("textbox", { name: "Server URL" })
    .fill("https://pve.test:8006");
  const password = page.getByRole("textbox", { name: "Password", exact: true });
  await password.fill("mock-password");
  await password.press("Enter");
  // The browser mock takes a moment to log in
  const next = page.locator("wizard-shell .footer-right wa-button");
  await expect(next).toHaveText("Connecting...");
  await expect(next).toHaveAttribute("loading", "");
  // The footer's own live region; the fields' hints are live regions too
  await expect(
    page.locator("wizard-shell .footer-right [aria-live=polite]")
  ).toHaveText("Connecting...");
  await expect(password).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Configure virtual machine" })
  ).toBeFocused();
});

test("cancelling the erase question returns to Install", async ({ page }) => {
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
  await skipWifiStep(page);
  // Checking the drive first leaves Install focused, for the dialog to return to
  const install = page.getByRole("button", { name: "Install", exact: true });
  await install.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(install).toBeFocused();
});

test("a VM install moves the focus from Cancel as it hides", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.getByRole("button", { name: "Proxmox server" }).click();
  await page
    .getByRole("textbox", { name: "Server URL" })
    .fill("https://pve.test:8006");
  await page
    .getByRole("textbox", { name: "Password", exact: true })
    .fill("mock-password");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await approveProxmoxImport(page);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  const footer = page.locator("wizard-shell .footer:has(.footer-left)");
  const before = await footer.boundingBox();
  await cancel.focus();
  // Creating the VM can't be stopped, so Cancel goes, in place
  await expect(cancel).toBeHidden({ timeout: 20000 });
  await expect(
    page.locator("proxmox-progress-view").getByRole("heading")
  ).toBeFocused();
  expect(await footer.boundingBox()).toEqual(before);
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
    // Each pair is a foreground, then what it is drawn on from the top down
    const text = [
      ["--ha-primary-fill", "#ffffff"],
      ["--ha-primary-color", "--ha-background-color"],
      ["--ha-error-color", "--ha-background-color"],
      ["--ha-error-color", "--ha-card-background"],
      // Placeholders, like the example formats in the Proxmox connect form
      [
        "--wa-form-control-placeholder-color",
        "--wa-form-control-background-color",
      ],
      // Plain buttons (Back, Cancel), at rest and hovered, on the page and in
      // dialogs
      ["--wa-color-neutral-on-quiet", "--ha-background-color"],
      [
        "--wa-color-neutral-on-quiet",
        "--wa-color-neutral-fill-quiet",
        "--ha-background-color",
      ],
      [
        "--wa-color-neutral-on-quiet",
        "--wa-color-neutral-fill-quiet",
        "--ha-card-background",
      ],
    ];
    // Field outlines and the focus ring only need 3:1 (WCAG 1.4.11)
    const nonText = [
      ["--wa-color-focus", "--ha-background-color"],
      ["--wa-color-focus", "--ha-card-background"],
      ["--wa-form-control-border-color", "--wa-form-control-background-color"],
      ["--wa-form-control-border-color", "--ha-card-background"],
      // The rings of steps not reached yet
      ["--ha-inactive-color", "--ha-background-color"],
    ];
    // Let the browser resolve tokens, keywords and color-mix() to rgb() or
    // color(srgb …)
    const colors = await page.evaluate(
      (values) => {
        const probe = document.body.appendChild(document.createElement("span"));
        const resolved = Object.fromEntries(
          values.map((value) => {
            if (value.startsWith("--")) {
              // An unknown token would inherit the text colour and pass
              if (!getComputedStyle(probe).getPropertyValue(value)) {
                throw new Error(`${value} is not set`);
              }
              probe.style.color = `var(${value})`;
            } else {
              probe.style.color = value;
            }
            return [value, getComputedStyle(probe).color];
          })
        );
        probe.remove();
        return resolved;
      },
      [...new Set([...text, ...nonText].flat())]
    );
    for (const [minimum, pairs] of [
      [4.5, text],
      [3, nonText],
    ] as const) {
      for (const pair of pairs) {
        const [foreground, ...backgrounds] = pair.map((value) => colors[value]);
        expect(
          contrast(foreground, ...backgrounds),
          pair.join(" on ")
        ).toBeGreaterThanOrEqual(minimum);
      }
    }
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

  test(`${colorScheme} architecture cards keep their text readable when selected or hovered`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/");
    await page.getByRole("button", { name: "Let's go" }).click();
    await page
      .locator('option-card[heading="Mini PC or other computer"]')
      .click();
    await page
      .locator("minipc-setup-method-view")
      .locator("option-card, wa-radio")
      .filter({ hasText: "I can connect the drive" })
      .click();
    const cards = page
      .locator("minipc-architecture-selection-view")
      .locator("wa-radio");
    const selected = cards.filter({ hasText: "Intel/AMD" });
    const hovered = cards.filter({ hasText: "ARM" });
    await selected.click();
    await expect(selected).toHaveAttribute("aria-checked", "true");
    await hovered.hover();
    for (const card of [selected, hovered]) {
      const { fill, background, text } = await card.evaluate((radio) => ({
        fill: getComputedStyle(radio).backgroundColor,
        // The cards sit straight on the page
        background: getComputedStyle(document.documentElement).backgroundColor,
        text: [
          ...radio.querySelectorAll(".option-description, .option-examples"),
        ].map((line) => getComputedStyle(line).color),
      }));
      expect(text).toHaveLength(2);
      for (const color of text) {
        expect(contrast(color, fill, background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
}

test("forced colors keep step states and the chosen architecture apart", async ({
  page,
}, testInfo) => {
  // Forced colors paint backgrounds like the page and give every border the
  // same color, unless a rule asks for system colors
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.getByRole("button", { name: "Mini PC or other computer" }).click();
  await page.getByRole("button", { name: "I can connect the drive" }).click();
  const system = await page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const resolve = (color: string) => {
      probe.style.color = color;
      return getComputedStyle(probe).color;
    };
    const colors = {
      canvasText: resolve("CanvasText"),
      grayText: resolve("GrayText"),
      highlight: resolve("Highlight"),
      highlightText: resolve("HighlightText"),
    };
    probe.remove();
    return colors;
  });
  const transparent = /^rgba\(.*, 0\)$/;

  const dots = page.locator("step-indicator .step-dot");
  // Completed: a filled dot
  await expect(dots.nth(0)).toHaveCSS("background-color", system.canvasText);
  await expect(dots.nth(0)).toHaveCSS("outline-style", "none");
  // Current: a filled dot in a ring
  await expect(dots.nth(1)).toHaveCSS("background-color", system.highlight);
  await expect(dots.nth(1)).toHaveCSS("outline-style", "solid");
  await expect(dots.nth(1)).toHaveCSS("outline-color", system.highlight);
  // Upcoming: an empty ring
  await expect(dots.nth(2)).toHaveCSS("background-color", transparent);
  await expect(dots.nth(2)).toHaveCSS("border-top-style", "solid");
  await expect(dots.nth(2)).toHaveCSS("border-top-width", "2px");
  await expect(dots.nth(2)).toHaveCSS("border-top-color", system.grayText);

  const choices = page.locator("minipc-architecture-selection-view wa-radio");
  const x86 = choices.filter({ hasText: "Intel/AMD (x86-64)" });
  const arm = choices.filter({ hasText: "ARM (aarch64)" });
  await x86.click();
  await expect(x86).toHaveCSS("border-top-color", system.highlight);
  await expect(arm).not.toHaveCSS("border-top-color", system.highlight);
  const check = x86.locator(".selected-indicator");
  await expect(check).toBeVisible();
  await expect(check).toHaveCSS("background-color", system.highlight);
  await expect(check).toHaveCSS("color", system.highlightText);
  await expect(arm.locator(".selected-indicator")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("forced-colors.png") });

  // The install's stage list draws its dots the same way
  await page.evaluate(async () => {
    document.querySelector("app-shell")!.remove();
    const progress = document.createElement(
      "install-progress"
    ) as HTMLElement & {
      stages: { id: string; label: string }[];
      stage: string;
      updateComplete: Promise<unknown>;
    };
    progress.stages = [
      { id: "downloading", label: "Download" },
      { id: "writing", label: "Write" },
      { id: "verifying", label: "Verify" },
    ];
    progress.stage = "writing";
    document.body.append(progress);
    await progress.updateComplete;
  });
  const stageDots = page.locator("install-progress .stage-dot");
  await expect(stageDots.nth(0)).toHaveCSS(
    "background-color",
    system.canvasText
  );
  // The pulse would be painted like the page, so the dot holds still
  await expect(stageDots.nth(1)).toHaveCSS("animation-name", "none");
  await expect(stageDots.nth(1)).toHaveCSS(
    "background-color",
    system.highlight
  );
  await expect(stageDots.nth(1)).toHaveCSS("outline-color", system.highlight);
  await expect(stageDots.nth(2)).toHaveCSS("background-color", transparent);
  await expect(stageDots.nth(2)).toHaveCSS("border-top-color", system.grayText);
});

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
        _startInstall: () => Promise<void>;
        _progress: unknown;
        _stage: string;
        _bytesProcessed: number;
        _totalBytes: number;
        updateComplete: Promise<unknown>;
      };
      // Isolated rendered view: never begin an install or call native commands.
      progress._startInstall = async () => {};
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
    // The stage's live region, then the warning's, which waits empty for a
    // problem so its first one is announced too
    await expect(page.getByRole("status")).toHaveCount(2);
    await expect(page.getByRole("status").first()).toHaveText("Downloading");
    await expect(page.getByRole("status").nth(1)).toHaveText("");
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
      "rgb(255, 255, 255)"
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
  await skipWifiStep(page);
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
