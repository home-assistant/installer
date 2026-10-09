import { expect, test } from "@playwright/test";

for (const flow of ["sbc", "utm", "proxmox"]) {
  // These widths exercise browser responsiveness below the native 800px minimum.
  for (const width of [320, 390, 481, 500, 520]) {
    test(`${flow} artwork and caption fit at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await page.evaluate(async (flow) => {
        document.body.replaceChildren();
        document.body.style.padding = "24px";
        const statePath = "/src/state/wizard-state.ts";
        const mockPath = "/test/unit/tauri-ipc.ts";
        const { wizardState } = await import(statePath);
        const { mockTauriIpc } = await import(mockPath);
        const tag = flow === "sbc" ? "progress-view" : `${flow}-progress-view`;
        await customElements.whenDefined(tag);
        wizardState.startFlow(flow === "utm" ? "vm" : flow);
        wizardState.setSelection("proxmoxSession", {
          server_url: "https://pve.example:8006",
          ticket: "fixture",
          csrf_token: "fixture",
        });
        wizardState.setSelection("drive", "mock-drive");
        wizardState.setSelection("deviceConfig", {
          board: "rpi5-64",
          download_url: "https://example.test/image.xz",
        });
        const bridge = window as unknown as {
          artworkProgress: (stage: string) => void;
          artworkFail: () => void;
        };
        mockTauriIpc(
          (
            _command: string,
            args: {
              progressChannel: {
                onmessage: (progress: Record<string, unknown>) => void;
              };
            }
          ) =>
            new Promise((_resolve, reject) => {
              bridge.artworkProgress = (stage) =>
                args.progressChannel.onmessage({
                  stage,
                  progress: stage === "complete" ? 100 : 42,
                  bytes_processed: 42,
                  total_bytes: 100,
                });
              bridge.artworkFail = () =>
                reject("Mock installation interrupted");
            })
        );
        const view = document.createElement(tag);
        view.style.height = "calc(100vh - 48px)";
        document.body.append(view);
      }, flow);
      const mascot = page.locator("casita-mascot");
      const caption = page.locator(".cloud-text");
      await expect(mascot).toBeVisible();
      await expect(mascot.locator("img")).toHaveAttribute(
        "src",
        "/assets/casita/Focusing.svg"
      );
      await expect(caption).toBeVisible();
      for (const graphic of [
        mascot,
        caption,
        page.locator(".thinking-cloud"),
      ]) {
        const bounds = await graphic.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
      }
      const cloud = await page.locator(".thinking-cloud").boundingBox();
      const mascotBounds = await mascot.boundingBox();
      expect(cloud!.y + cloud!.height).toBeLessThanOrEqual(mascotBounds!.y);
      await page.evaluate(() =>
        (
          window as unknown as { artworkProgress: (stage: string) => void }
        ).artworkProgress("complete")
      );
      if (flow !== "sbc") {
        // A VM is not complete when the backend is done with it: the view
        // still waits for Home Assistant. Exercise the terminal render state
        // without running provisioning or changing that pipeline contract.
        await page.locator(`${flow}-progress-view`).evaluate((view) => {
          (view as unknown as { _stage: string })._stage = "complete";
        });
      }
      await expect(mascot.locator("img")).toHaveAttribute(
        "src",
        "/assets/casita/Happy.svg"
      );
      // Failure belongs to a fresh operation, not the completed happy fixture.
      await page.evaluate((flow) => {
        const tag = flow === "sbc" ? "progress-view" : `${flow}-progress-view`;
        const view = document.createElement(tag);
        view.style.height = "calc(100vh - 48px)";
        document.body.replaceChildren(view);
      }, flow);
      await expect(mascot.locator("img")).toHaveAttribute(
        "src",
        "/assets/casita/Focusing.svg"
      );
      await page.evaluate(() =>
        (window as unknown as { artworkFail: () => void }).artworkFail()
      );
      await expect(mascot.locator("img")).toHaveAttribute(
        "src",
        "/assets/casita/Problem.svg"
      );
      await expect(
        page.getByText("Installation failed", { exact: true })
      ).toBeVisible();
    });
  }
}

test("welcome artwork leaves the footer reachable on short screens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await expect(page.locator(".ohf-link")).toHaveCSS("position", "static");
  await expect(page.getByRole("button", { name: "Let's go" })).toBeInViewport();
  await page.locator("welcome-view").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator(".ohf-link")).toBeInViewport();
  const footer = await page.locator(".ohf-link").boundingBox();
  expect(footer!.y + footer!.height).toBeLessThan(488);
});

for (const [width, height] of [
  [900, 780],
  [800, 750],
]) {
  test(`welcome preserves footer positioning at native ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    const footer = page.locator(".ohf-link");
    await expect(footer).toHaveCSS("position", "absolute");
    await expect(footer).toBeInViewport();
    const bounds = await footer.boundingBox();
    const link = await page.locator(".learn-more").boundingBox();
    expect(bounds!.y + bounds!.height).toBeCloseTo(height - 32, 0);
    expect(link!.y + link!.height).toBeLessThan(bounds!.y);
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
    bridge.__TAURI__ = {};
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

test("every supplied mood loads as nonblank static decorative artwork", async ({
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
    "unknown",
  ]) {
    const result = await page.evaluate(async (mood) => {
      const mascot = document
        .querySelector("app-shell")!
        .shadowRoot!.querySelector("welcome-view")!
        .shadowRoot!.querySelector("casita-mascot")!;
      mascot.setAttribute("mood", mood);
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
        alt: image.alt,
        animated: /<animate|<set\b|@keyframes/.test(source),
        source: image.getAttribute("src"),
      };
    }, mood);
    expect(result.opaque).toBeGreaterThan(100);
    expect(result.alt).toBe("");
    expect(result.animated).toBe(false);
    expect(result.source).toBe(
      `/assets/casita/${mood === "unknown" ? "Happy" : mood[0].toUpperCase() + mood.slice(1)}.svg`
    );
  }
});
