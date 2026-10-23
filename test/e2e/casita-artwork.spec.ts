import { expect, test } from "./fixtures.js";

// Below the native 800px minimum, in a padded page; install-progress's unit
// tests measure the bare layout from 320 to 639px
test("sbc artwork and caption fit at 320px", async ({ page }) => {
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
  const caption = page.locator(".cloud-text");
  await expect(mascot).toBeVisible();
  await expect(caption).toBeVisible();
  for (const graphic of [mascot, caption, page.locator(".thinking-cloud")]) {
    const bounds = await graphic.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
  }
  const cloud = await page.locator(".thinking-cloud").boundingBox();
  const mascotBounds = await mascot.boundingBox();
  expect(cloud!.y + cloud!.height).toBeLessThanOrEqual(mascotBounds!.y);
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
  await expect(page.locator("casita-mascot img")).toHaveAttribute(
    "src",
    "/assets/casita/Sad.svg"
  );
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

test("every supplied mood loads as nonblank static artwork", async ({
  page,
}) => {
  await page.goto("/");
  // The app shell loads after locale detection, so wait for it to render.
  await page.locator("welcome-view").waitFor({ state: "attached" });
  for (const mood of [
    "happy",
    "grinning",
    "loving",
    "winking",
    "loading",
    "focusing",
    "sad",
    "problem",
  ]) {
    const result = await page.evaluate(async (mood) => {
      await customElements.whenDefined("casita-mascot");
      const mascot = document.createElement("casita-mascot") as HTMLElement & {
        updateComplete: Promise<boolean>;
      };
      mascot.setAttribute("mood", mood);
      document.body.replaceChildren(mascot);
      await mascot.updateComplete;
      const image = mascot.shadowRoot!.querySelector("img")!;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 120;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0, 120, 120);
      const pixels = context.getImageData(0, 0, 120, 120).data;
      let opaque = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) opaque++;
      const source = await (await fetch(image.src)).text();
      return {
        opaque,
        animated: /<animate|<set\b|@keyframes/.test(source),
      };
    }, mood);
    expect(result.opaque).toBeGreaterThan(100);
    expect(result.animated).toBe(false);
  }
});
