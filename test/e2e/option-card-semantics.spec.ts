import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

// An option card is named by its heading alone and described by its
// description. A card that opens a page in the browser is a link that says
// so. Keys act once, as on a native button.

async function showCards(page: Page) {
  await page.goto("/");
  await page.locator("welcome-view").waitFor({ state: "attached" });
  await page.evaluate(() => {
    document.querySelector("app-shell")!.remove();
    for (const heading of ["First option", "Second option"]) {
      const card = document.createElement("option-card");
      card.setAttribute("heading", heading);
      card.setAttribute("description", `About the ${heading.toLowerCase()}`);
      card.dataset.clicks = "0";
      card.addEventListener("click", () => {
        card.dataset.clicks = String(Number(card.dataset.clicks) + 1);
      });
      document.body.append(card);
    }
  });
}

async function openOtherOptions(page: Page) {
  await page.addInitScript(() => {
    window.open = (url) => {
      const opened = document.documentElement.dataset.opened;
      document.documentElement.dataset.opened = `${opened ?? ""}${String(url)} `;
      return null;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page
    .getByRole("button", { name: "Other options", exact: true })
    .click();
  await expect(page.locator("other-options-view")).toBeVisible();
}

test("a path is named by its heading and described by its description", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Let's go" }).click();

  const proxmox = page.getByRole("button", {
    name: "Proxmox server",
    exact: true,
  });
  await expect(proxmox).toHaveAccessibleDescription(
    "Create a VM on your Proxmox virtualization server"
  );
});

test("an other installation method is a link that opens in the browser", async ({
  page,
}) => {
  await openOtherOptions(page);

  const container = page.getByRole("link", {
    name: "Home Assistant Container",
    exact: true,
  });
  await expect(container).toHaveAccessibleDescription(
    "Opens in your browser. Run it with Docker, without apps (add-ons) or the Supervisor"
  );
  // The five methods and the comparison in the subtitle
  await expect(page.getByRole("link")).toHaveCount(6);
});

test("the focused card shows the focus ring", async ({ page }) => {
  await showCards(page);
  const card = page.locator("option-card").first();

  await page.keyboard.press("Tab");
  await expect(card).toBeFocused();
  await expect(card.locator(".card")).not.toHaveCSS("outline-style", "none");
});

test("Space acts when it comes up, and only once when held", async ({
  page,
}) => {
  await showCards(page);
  const [first, second] = [
    page.locator("option-card").first(),
    page.locator("option-card").last(),
  ];

  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await page.keyboard.down("Space");
  await page.keyboard.down("Space");
  await page.keyboard.down("Space");
  await expect(first).toHaveAttribute("data-clicks", "0");
  await page.keyboard.up("Space");
  await expect(first).toHaveAttribute("data-clicks", "1");

  // Moving on with Space still down cancels it
  await page.keyboard.down("Space");
  await page.keyboard.press("Tab");
  await expect(second).toBeFocused();
  await page.keyboard.up("Space");
  await expect(first).toHaveAttribute("data-clicks", "1");
  await expect(second).toHaveAttribute("data-clicks", "0");
});

test("Enter acts when it goes down, and only once when held", async ({
  page,
}) => {
  await showCards(page);
  const first = page.locator("option-card").first();

  await page.keyboard.press("Tab");
  await page.keyboard.down("Enter");
  await expect(first).toHaveAttribute("data-clicks", "1");
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  await expect(first).toHaveAttribute("data-clicks", "1");
});

test("holding Enter on a guide opens it once, and Space leaves it", async ({
  page,
}) => {
  await openOtherOptions(page);
  const container = page.getByRole("link", {
    name: "Home Assistant Container",
    exact: true,
  });
  const guides = "https://www.home-assistant.io/installation/";

  await container.focus();
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  // A link takes only Enter
  await page.keyboard.press("Space");
  // Opening the next guide shows that nothing else opened before it
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute(
    "data-opened",
    `${guides}linux#docker-compose ${guides}alternative#synology-nas `
  );
});
