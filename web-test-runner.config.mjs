import { esbuildPlugin } from "@web/dev-server-esbuild";

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
