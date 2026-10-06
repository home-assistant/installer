import { esbuildPlugin } from "@web/dev-server-esbuild";

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
      tsconfig: "./tsconfig.test.json",
    }),
  ],
  testFramework: {
    config: {
      ui: "bdd",
      timeout: 5000,
    },
  },
};
