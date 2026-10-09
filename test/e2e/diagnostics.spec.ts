import { test, expect, type Page } from "@playwright/test";

// Browser tests mock native IPC, metadata, clipboard and folder/browser opening.
// No disk is written and no VM or network connection is created.
async function mockDesktop(page: Page, failingCommand = "") {
  await page.evaluate(async (failingCommand) => {
    const path = "/src/api/mock-data.ts";
    const { MOCK_BLOCK_DEVICES, MOCK_MANIFEST, MOCK_HAOS_RELEASE } =
      await import(path);
    const state = window as unknown as {
      __TAURI__: object;
      __TAURI_INTERNALS__: object;
      diagnosticEvents: unknown[];
      openedReport: string;
      copiedDiagnostics: string;
      logsOpened: boolean;
    };
    state.__TAURI__ = {};
    state.diagnosticEvents = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          state.copiedDiagnostics = text;
        },
      },
    });
    state.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: Record<string, unknown>) => {
        if (command === failingCommand) {
          const channel = args.progressChannel as
            | { onmessage?: (data: unknown) => void }
            | undefined;
          channel?.onmessage?.({
            stage: "verifying",
            progress: 80,
            bytes_processed: 0,
            total_bytes: 0,
            message: "Verifying",
          });
          throw "Network error: https://fake-user:fake-password@fake-host/?ticket=fake-ticket&csrf=fake-csrf";
        }
        switch (command) {
          case "log_frontend_event":
            state.diagnosticEvents.push(args);
            return;
          case "plugin:app|version":
            return "0.1.0-test";
          case "get_diagnostics":
            return {
              version: "0.1.0-test",
              os: "linux",
              os_version: "6.12",
              architecture: "x86_64",
              package_type: "AppImage",
              log_tail: state.diagnosticEvents
                .map((event) => JSON.stringify(event))
                .join("\n"),
            };
          case "plugin:opener|open_url":
            state.openedReport = args.url as string;
            return;
          case "open_logs_folder":
            state.logsOpened = true;
            return;
          case "list_block_devices":
            return MOCK_BLOCK_DEVICES;
          case "get_manifest":
            return MOCK_MANIFEST;
          case "get_haos_release":
          case "get_utm_haos_release":
            return MOCK_HAOS_RELEASE;
          case "check_connection":
            return;
          // A trusted certificate: no confirmation before the login
          case "proxmox_certificate_fingerprint":
            return null;
          case "get_system_info":
            return { cpu_cores: 8, memory_mb: 16384 };
          case "check_utm_status":
            return {
              installed: true,
              version: "4.5",
              path: "/Applications/UTM.app",
            };
          case "download_utm_image":
            return "/tmp/fake-image.qcow2";
          case "discard_utm_image":
            return;
          default:
            throw new Error(`Unexpected mock command: ${command}`);
        }
      },
    };
  }, failingCommand);
}

async function assertReport(page: Page, flow: string, stage: string) {
  await page
    .getByRole("button", { name: "Report a problem", exact: true })
    .click();
  const dialog = page.locator("diagnostics-actions wa-dialog");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(dialog).toContainText("GitHub issues are public");
  const text = await dialog
    .getByRole("textbox", { name: "Diagnostics" })
    .inputValue();
  expect(text).toContain(`flow: ${flow}`);
  expect(text).toContain(`stage: ${stage}`);
  for (const secret of [
    "fake-user",
    "fake-password",
    "fake-host",
    "fake-ticket",
    "fake-csrf",
  ])
    expect(text).not.toContain(secret);
  await dialog
    .getByRole("button", { name: "Copy diagnostics", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("Diagnostics copied");
  await dialog
    .getByRole("button", { name: "Open logs folder", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("Logs folder opened");
  await dialog
    .getByRole("button", { name: "Report a problem", exact: true })
    .click();
  const result = await page.evaluate(() => {
    const state = window as unknown as {
      copiedDiagnostics: string;
      openedReport: string;
      logsOpened: boolean;
      diagnosticEvents: unknown[];
    };
    return {
      copied: state.copiedDiagnostics,
      report: state.openedReport,
      opened: state.logsOpened,
      events: JSON.stringify(state.diagnosticEvents),
    };
  });
  expect(result.copied).toBe(text);
  expect(result.opened).toBe(true);
  const url = new URL(result.report);
  expect(url.searchParams.get("stage")).toBe(stage);
  expect(url.searchParams.get("flow")).toBe(flow);
  expect(url.searchParams.get("error")).toBe("network_error");
  expect(result.report.length).toBeLessThanOrEqual(7500);
  expect(result.events).not.toContain("fake-");
}

test("About shows native metadata and manual diagnostic actions", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await mockDesktop(page);
  await page.getByRole("button", { name: "About", exact: true }).click();
  const dialog = page.locator("diagnostics-actions wa-dialog");
  await expect(dialog).toContainText("Home Assistant Installer 0.1.0-test");
  await expect(
    dialog.getByRole("textbox", { name: "Diagnostics" })
  ).toHaveValue(/package: AppImage/);
  await page.screenshot({
    path: testInfo.outputPath("about-mocked-native.png"),
    animations: "disabled",
    fullPage: false,
  });
});

test("Proxmox connection failure exports only safe diagnostics", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await mockDesktop(page, "proxmox_connect");
  await page.locator("welcome-view wa-button").click();
  await page.locator('option-card[title="Proxmox server"]').click();
  const view = page.locator("proxmox-connect-view");
  await view.locator("#server-url").fill("https://fake-host:8006");
  await view.locator("#username").fill("fake-user");
  await view.locator("#password").fill("fake-password");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(view).toContainText("Network error");
  await page.evaluate(() => {
    window.dispatchEvent(
      new ErrorEvent("error", { message: "fake-private-error" })
    );
    window.dispatchEvent(new Event("unhandledrejection"));
  });
  await assertReport(page, "proxmox", "connecting");
  const diagnosticText = await page
    .getByRole("textbox", { name: "Diagnostics" })
    .inputValue();
  expect(diagnosticText).toContain("frontend_error");
  expect(diagnosticText).toContain("unhandled_rejection");
  expect(diagnosticText).not.toContain("fake-private-error");
  await page.screenshot({
    path: testInfo.outputPath("proxmox-report-mocked-native.png"),
    animations: "disabled",
    fullPage: false,
  });
});

test("frontend failures omit payloads and clipboard rejection keeps selectable text", async ({
  page,
}) => {
  await page.goto("/");
  await mockDesktop(page);
  await page.evaluate(() => {
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "fake-secret-password",
        filename: "https://fake-user:fake-password@fake-host",
        error: new Error("fake-ticket\nfake-csrf"),
      })
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard denied");
        },
      },
    });
  });
  await page.getByRole("button", { name: "About", exact: true }).click();
  const dialog = page.locator("diagnostics-actions wa-dialog");
  const text = dialog.getByRole("textbox", { name: "Diagnostics" });
  await expect(text).toHaveValue(/error: frontend_error/);
  expect(await text.inputValue()).not.toContain("fake-");
  await dialog
    .getByRole("button", { name: "Copy diagnostics", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "Could not copy diagnostics"
  );
  expect(
    await text.evaluate(
      (element: HTMLTextAreaElement) =>
        element.selectionEnd - element.selectionStart
    )
  ).toBe((await text.inputValue()).length);
});

test("flash failure keeps the failed stage in its report", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await mockDesktop(page, "flash_image");
  await page.locator("welcome-view wa-button").click();
  await page
    .locator('option-card[title="Raspberry Pi & other boards"]')
    .click();
  await page.locator("device-selection-view device-card").first().click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.locator("drive-selection-view drive-card").first().click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.locator("wizard-shell .footer-right wa-button").click();
  await page.locator('confirm-dialog wa-button[variant="danger"]').click();
  await expect(page.locator("progress-view")).toContainText("Network error");
  await page.screenshot({
    path: testInfo.outputPath("flash-error-mocked-native.png"),
    animations: "disabled",
    fullPage: false,
  });
  await assertReport(page, "flash", "verifying");
  await page.screenshot({
    path: testInfo.outputPath("flash-report-mocked-native.png"),
    animations: "disabled",
    fullPage: false,
  });
});

test("UTM creation failure reports its stage", async ({ page }, testInfo) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
    })
  );
  await page.goto("/");
  await mockDesktop(page, "create_utm_vm");
  await page.locator("welcome-view wa-button").click();
  await page.locator('option-card[title="Virtual machine"]').click();
  await expect(page.locator("utm-check-view")).toContainText(
    "UTM is installed"
  );
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.locator("wizard-shell .footer-right wa-button").click();
  await expect(page.locator("utm-progress-view")).toContainText(
    "Network error"
  );
  await assertReport(page, "utm", "creating");
  await page.screenshot({
    path: testInfo.outputPath("utm-report-mocked-native.png"),
    animations: "disabled",
    fullPage: false,
  });
});
