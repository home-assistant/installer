import { esbuildPlugin } from "@web/dev-server-esbuild";
import { chromeLauncher } from "@web/test-runner";

// The built-in `a11ySnapshot` command only returns "interesting" nodes, which
// drops structural roles like radiogroup. This one returns the full tree so
// tests can assert the accessible name Chrome computes for any node.
function fullA11ySnapshotPlugin() {
  return {
    name: "full-a11y-snapshot-command",
    async executeCommand({ command, session }) {
      if (command !== "full-a11y-snapshot") return undefined;
      if (session.browser.type !== "puppeteer") {
        throw new Error(
          `full-a11y-snapshot is not supported for ${session.browser.type}`
        );
      }
      const page = session.browser.getPage(session.id);
      return page.accessibility.snapshot({ interestingOnly: false });
    },
  };
}

export default {
  files: "test/unit/**/*.test.ts",
  // Load the app's theme, as index.html does, so components get its tokens.
  // They have no fallbacks of their own.
  testRunnerHtml: (testFramework) =>
    `<!DOCTYPE html><html><head><link rel="stylesheet" href="/src/styles.css" /></head><body><script type="module" src="${testFramework}"></script></body></html>`,
  // Chrome follows the OS's light or dark mode, and so does the theme. Light
  // everywhere, so a test reads the same colours on every machine.
  browsers: [
    chromeLauncher({
      async createPage({ context }) {
        const page = await context.newPage();
        await page.emulateMediaFeatures([
          { name: "prefers-color-scheme", value: "light" },
        ]);
        return page;
      },
    }),
  ],
  // Covers launching Chrome and opening the first page, not any test. Cold CI
  // runners have taken up to 27s of the default 30s.
  browserStartTimeout: 60000,
  // Prefer the "browser" export condition so browser-only builds of deps are
  // used (e.g. nanoid, pulled in transitively by Web Awesome, whose default
  // export targets Node's `node:crypto` and fails in the browser).
  nodeResolve: {
    exportConditions: ["browser", "import", "default"],
    browser: true,
  },
  plugins: [
    fullA11ySnapshotPlugin(),
    esbuildPlugin({
      ts: true,
      loaders: { ".json": "json" },
      // The plugin passes raw config to esbuild, which does not resolve
      // extends. Read the shared compiler settings directly.
      tsconfig: "./tsconfig.json",
      // Vite sets this; the unit tests run through esbuild instead, and use
      // the same browser mock as the dev server.
      define: { "import.meta.env.DEV": "true" },
    }),
  ],
  testFramework: {
    config: {
      ui: "bdd",
      timeout: 5000,
    },
  },
};
