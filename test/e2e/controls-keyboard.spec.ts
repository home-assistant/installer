import { test, expect, type Locator, type Page } from "@playwright/test";

// Traverse the real tab order instead of focusing controls programmatically.
async function tabTo(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  for (let count = 0; count < 40; count++) {
    if (await control.evaluate((el) => el.matches(":focus"))) return;
    await page.keyboard.press("Tab");
  }
  await expect(control).toBeFocused();
}

async function activate(page: Page, control: Locator, key = "Enter") {
  await tabTo(page, control);
  await page.keyboard.press(key);
}

async function start(page: Page, name: string) {
  await page.goto("/");
  await activate(page, page.getByRole("button", { name: "Let's go" }));
  await activate(page, page.getByRole("button", { name, exact: false }));
}

async function next(page: Page) {
  await activate(page, page.getByRole("button", { name: "Next", exact: true }));
}

test("Mini PC choices work with Tab, Space, and arrow keys", async ({
  page,
}) => {
  await start(page, "Generic (mini) PC");
  await activate(
    page,
    page.getByRole("button", { name: "I need to boot from USB" }),
    "Space"
  );
  await expect(page.getByRole("dialog")).toBeVisible();
  await activate(
    page,
    page.getByRole("button", { name: "Go back", exact: true })
  );
  await activate(
    page,
    page.getByRole("button", { name: "I can connect the drive" })
  );
  await expect(
    page.getByRole("radiogroup", { name: "CPU architecture" })
  ).toBeVisible();
  const intel = page.getByRole("radio", { name: "Intel/AMD" });
  const arm = page.getByRole("radio", { name: "ARM (aarch64)" });
  await tabTo(page, intel);
  await page.keyboard.press("Space");
  await expect(intel).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(arm).toBeChecked();
  await page.keyboard.press("ArrowLeft");
  await expect(intel).toBeChecked();
  await next(page);
  await expect(page.locator("drive-selection-view")).toBeVisible();
  await activate(page, page.getByRole("radio").first(), "Space");
  await next(page);
  await activate(
    page,
    page.getByRole("button", { name: "Install", exact: true })
  );
  await activate(
    page,
    page.getByRole("button", { name: "Erase and install", exact: true })
  );
  await expect(page.locator("success-view")).toBeVisible({ timeout: 20000 });
});

test("the existing board flow remains keyboard accessible", async ({
  page,
}) => {
  await start(page, "Raspberry Pi & other boards");
  await activate(
    page,
    page.getByRole("radio", { name: "Raspberry Pi 5", exact: true }),
    "Space"
  );
  await next(page);
  await activate(page, page.getByRole("radio").first(), "Space");
  await next(page);
  await activate(
    page,
    page.getByRole("button", { name: "Install", exact: true })
  );
  await activate(
    page,
    page.getByRole("button", { name: "Erase and install", exact: true })
  );
  await expect(page.locator("success-view")).toBeVisible({ timeout: 20000 });
});

test("every external installation guide can be opened with the keyboard", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.open = (url) => {
      document.documentElement.dataset.openedUrl = String(url);
      return null;
    };
  });
  await start(page, "Others");
  const guides = page.locator("other-options-view option-card");
  const urls = ["linux#docker-compose", "synology", "qnap", "linux", "windows"];
  await expect(guides).toHaveCount(urls.length);
  for (let index = 0; index < urls.length; index++) {
    await activate(page, guides.nth(index), index % 2 ? "Space" : "Enter");
    await expect(page.locator("html")).toHaveAttribute(
      "data-opened-url",
      `https://www.home-assistant.io/installation/${urls[index]}`
    );
  }
});

for (const flow of ["proxmox", "utm"] as const) {
  test(`${flow} controls keep accessible values and keyboard edits on revisit`, async ({
    page,
  }) => {
    if (flow === "utm") {
      await page.addInitScript(() =>
        Object.defineProperty(navigator, "userAgent", {
          value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        })
      );
    }
    await start(page, flow === "utm" ? "Virtual machine" : "Proxmox server");
    if (flow === "proxmox") {
      for (const [name, value] of [
        ["Server URL", "https://pve.test:8006"],
        ["Username", "root@pam"],
        ["Password", "test-password"],
      ]) {
        const input = page.getByLabel(name, { exact: true });
        await tabTo(page, input);
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.type(value);
      }
    }
    await next(page);
    const view = page.locator(`${flow}-configure-view`);
    await expect(view).toBeVisible();
    const name = view.getByRole("textbox", { name: "Display name" });
    await tabTo(page, name);
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("my-home");
    if (flow === "proxmox") {
      for (const [label, value] of [
        ["Node", "pve2"],
        ["Storage", "local-lvm"],
      ]) {
        const select = view.getByRole("combobox", { name: label, exact: true });
        await tabTo(page, select);
        await page.keyboard.press("Space");
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        await expect(select).toHaveAttribute("aria-expanded", "false");
        await expect(
          view.locator(`wa-select[label="${label}"]`)
        ).toHaveJSProperty("value", value);
      }
      const vmId = view.getByRole("spinbutton", { name: "VM ID" });
      await tabTo(page, vmId);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("251");
    }
    for (const [label, before, after] of [
      ["CPU cores", "4 cores", "6 cores"],
      ["Memory", "4 GB", "6 GB"],
      ["Disk size", "32 GB", "64 GB"],
    ]) {
      const slider = view.getByRole("slider", { name: label, exact: true });
      await expect(slider).toHaveAttribute("aria-valuetext", before);
      await tabTo(page, slider);
      await page.keyboard.press("ArrowRight");
      await expect(slider).toHaveAttribute("aria-valuetext", after);
    }
    await next(page);
    await expect(page.locator(`${flow}-confirm-view`)).toContainText("my-home");
    await activate(
      page,
      page.getByRole("button", { name: "Back", exact: false })
    );
    await expect(name).toHaveValue("my-home");
    if (flow === "proxmox") {
      await expect(view.locator('wa-select[label="Node"]')).toHaveJSProperty(
        "value",
        "pve2"
      );
      await expect(view.locator('wa-select[label="Storage"]')).toHaveJSProperty(
        "value",
        "local-lvm"
      );
      await expect(view.getByRole("spinbutton", { name: "VM ID" })).toHaveValue(
        "251"
      );
    }
    for (const [label, value] of [
      ["CPU cores", "6 cores"],
      ["Memory", "6 GB"],
      ["Disk size", "64 GB"],
    ]) {
      await expect(
        view.getByRole("slider", { name: label, exact: true })
      ).toHaveAttribute("aria-valuetext", value);
    }
    await next(page);
    await activate(
      page,
      page.getByRole("button", { name: "Install", exact: true })
    );
    await expect(page.locator(`${flow}-success-view`)).toBeVisible({
      timeout: 20000,
    });
  });
}
