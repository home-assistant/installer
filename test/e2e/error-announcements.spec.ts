import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

/** A failure with no catalog text, so it shows the message as it is. */
const failure = (message: string) => ({
  code: "mock_failure",
  message,
  retryable: true,
  details: {},
});

/** Show `tag` on its own, every backend call failing with `message`. */
async function mount(page: Page, tag: string, message: string) {
  await page.goto("/");
  await page.locator("welcome-view").waitFor({ state: "attached" });
  await page.evaluate(
    async ({ tag, rejection }) => {
      const mockPath = "/test/unit/tauri-ipc.ts";
      const { mockTauriIpc } = await import(mockPath);
      mockTauriIpc(() => Promise.reject(rejection));
      await customElements.whenDefined(tag);
      document.body.replaceChildren(document.createElement(tag));
    },
    { tag, rejection: failure(message) }
  );
}

interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  description?: { value: string };
  properties?: { name: string; value: { value: unknown } }[];
  childIds?: string[];
}

/** The page as Chromium exposes it to screen readers. */
async function accessibilityTree(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
      nodes: AXNode[];
    };
    return nodes;
  } finally {
    await cdp.detach();
  }
}

const property = (node: AXNode, name: string) =>
  node.properties?.find((entry) => entry.name === name)?.value.value;

/**
 * The error has the focus, which is what reads it out, and nothing reads it
 * out a second time: no alert, and no other live region that says it.
 */
async function expectReadOutOnce(page: Page, message: string) {
  const error = page.locator("[data-focus-alert]");
  await expect(error).toBeFocused();
  await expect(error).toHaveText(message);
  await expect(page.getByRole("alert")).toHaveCount(0);
  if (test.info().project.name !== "chromium") return;

  const nodes = await accessibilityTree(page);
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const text = (node: AXNode): string =>
    node.role?.value === "StaticText"
      ? (node.name?.value ?? "")
      : (node.childIds ?? [])
          .map((id) => byId.get(id))
          .map((child) => (child ? text(child) : ""))
          .join(" ");
  const focused = nodes.find(
    (node) =>
      !node.ignored &&
      node.role?.value !== "RootWebArea" &&
      property(node, "focused") === true
  );
  // What a screen reader says when the focus lands on it
  expect(
    `${focused?.name?.value ?? ""} ${focused?.description?.value ?? ""}`
  ).toContain(message);
  const live = nodes.filter((node) =>
    ["polite", "assertive"].includes(property(node, "live") as string)
  );
  for (const region of live) expect(text(region)).not.toContain(message);
}

test("a catalog that fails to load is read out once, and again on each retry", async ({
  page,
}) => {
  const message = "The board list could not be loaded.";
  await mount(page, "device-selection-view", message);
  await expectReadOutOnce(page, message);

  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await retry.click();
  // The same failure again, so it takes the focus again to be read out
  await expect(page.locator("[data-focus-alert]")).toBeFocused();
  await expectReadOutOnce(page, message);
});

test("a connection check that fails is read out once", async ({ page }) => {
  const message = "The version service could not be reached.";
  await mount(page, "connection-check-view", message);
  await expectReadOutOnce(page, message);
});

test("an install that fails is read out once", async ({ page }) => {
  const message = "The drive is in use.";
  await mount(page, "install-progress", message);
  await page.evaluate(async (message) => {
    const progress = document.querySelector("install-progress")!;
    await progress.updateComplete;
    progress.error = message;
  }, message);
  await expectReadOutOnce(page, message);
});
