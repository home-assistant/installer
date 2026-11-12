import { expect, test } from "./fixtures.js";

// Below the native 800px minimum, in a padded page; install-progress's unit
// tests measure the bare layout from 320 to 639px
test("sbc artwork and heading fit at 320px", async ({ page }) => {
  const width = 320;
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/");
  // The app shell loads after locale detection, so wait for it to render.
  await page.locator("welcome-view").waitFor({ state: "attached" });
  // Load the modules in one evaluate and build the fixture in a second,
  // synchronous one. As a single async evaluate, Chromium intermittently
  // reports its promise as collected once the view starts, which
  // Playwright surfaces as "Execution context was destroyed".
  await page.evaluate(async () => {
    document.body.replaceChildren();
    document.body.style.padding = "24px";
    const statePath = "/src/state/wizard-state.ts";
    const mockPath = "/test/unit/tauri-ipc.ts";
    (window as unknown as { artworkModules: unknown }).artworkModules = {
      ...(await import(statePath)),
      ...(await import(mockPath)),
    };
    await customElements.whenDefined("progress-view");
  });
  await page.evaluate(() => {
    const { wizardState, mockTauriIpc } = (
      window as unknown as {
        artworkModules: {
          wizardState: {
            startFlow: (flow: string) => void;
            setSelection: (key: string, value: unknown) => void;
          };
          mockTauriIpc: (handler: (...args: never[]) => unknown) => void;
        };
      }
    ).artworkModules;
    wizardState.startFlow("sbc");
    wizardState.setSelection("drive", "mock-drive");
    wizardState.setSelection("deviceConfig", {
      board: "rpi5-64",
    });
    // The write never ends, so the view stays in progress
    mockTauriIpc(() => new Promise(() => {}));
    const view = document.createElement("progress-view");
    view.style.height = "calc(100vh - 48px)";
    document.body.append(view);
  });
  const mascot = page.locator("casita-mascot");
  const parts = page.getByRole("button", { name: /^step 1 of 5$/i });
  const heading = page.getByRole("heading", {
    name: "Downloading the Home Assistant image",
  });
  for (const part of [mascot, parts, heading]) {
    await expect(part).toBeVisible();
    const bounds = await part.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
  }
  // Casita stands above the column, which starts with the part
  const mascotBounds = await mascot.boundingBox();
  const partsBounds = await parts.boundingBox();
  expect(mascotBounds!.y + mascotBounds!.height).toBeLessThanOrEqual(
    partsBounds!.y
  );
});

for (const [width, height] of [
  [900, 780],
  [800, 750],
  [800, 500],
  [320, 568],
]) {
  test(`welcome keeps its footer at the bottom at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    const footer = page.locator("welcome-view .welcome-footer");
    await expect(footer).toBeInViewport({ ratio: 1 });
    const letsGo = page.getByRole("button", { name: "Let's go" });
    await expect(letsGo).toBeInViewport();
    const bounds = await footer.boundingBox();
    const button = await letsGo.boundingBox();
    expect(bounds!.y + bounds!.height).toBeCloseTo(height - 16, 0);
    expect(button!.y + button!.height).toBeLessThan(bounds!.y);
  });
}

test("UTM missing artwork leaves refresh and navigation reachable on mobile", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    })
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.evaluate(() => {
    const bridge = window as unknown as Record<string, unknown>;
    bridge.isTauri = true;
    bridge.__TAURI_INTERNALS__ = { invoke: async () => ({ installed: false }) };
  });
  await page
    .getByRole("button", { name: "Virtual machine", exact: false })
    .click();
  await expect(
    page.getByText("UTM is not installed", { exact: true })
  ).toBeVisible();
  await expect(page.locator("casita-mascot")).toHaveAttribute("mood", "sad");
  const refresh = page.getByRole("button", { name: "I've installed UTM" });
  await refresh.scrollIntoViewIfNeeded();
  await expect(refresh).toBeInViewport();
  await refresh.click();
  await expect(
    page.getByText("UTM is not installed", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true })
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("mobile-dark-utm-missing.png"),
  });
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`Casita ${reducedMotion === "reduce" ? "holds still" : "moves"} with reduced motion ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/");
    // The app shell loads after locale detection, so wait for it to render.
    await page.locator("welcome-view").waitFor({ state: "attached" });
    for (const mood of ["happy", "loading", "focusing", "sad", "problem"]) {
      const result = await page.evaluate(async (mood) => {
        await customElements.whenDefined("casita-mascot");
        const mascot = document.createElement(
          "casita-mascot"
        ) as HTMLElement & {
          updateComplete: Promise<boolean>;
        };
        mascot.setAttribute("mood", mood);
        document.body.replaceChildren(mascot);
        await mascot.updateComplete;
        const svg = mascot.shadowRoot!.querySelector("svg")!;
        const before = svg.innerHTML;
        await new Promise((resolve) => setTimeout(resolve, 400));
        const house = svg.querySelector("path")!.getBoundingClientRect();
        return {
          moved: svg.innerHTML !== before,
          width: house.width,
          height: house.height,
        };
      }, mood);
      expect(result.width).toBeGreaterThan(100);
      expect(result.height).toBeGreaterThan(90);
      expect(result.moved).toBe(reducedMotion === "no-preference");
    }
  });
}
