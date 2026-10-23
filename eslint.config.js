import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import litPlugin, { configs as litConfigs } from "eslint-plugin-lit";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";
import chaiFriendly from "eslint-plugin-chai-friendly";

export default [
  eslint.configs.recommended,
  prettierConfig,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: "module",
        project: ["./tsconfig.json", "./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      lit: litPlugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // tsc checks names already, and also sees the types a `declare global`
      // adds, which ESLint takes for undefined
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // The same Lit rules as the Home Assistant frontend
      ...litConfigs["flat/all"].rules,
      "lit/attribute-value-entities": "off",
      "lit/no-template-map": "off",
    },
  },
  {
    // styles.css sets every --ha-* theme token, and every page loads it, unit
    // tests included. A fallback would never show, so nothing would notice it
    // going stale, as the old HA blue had. --ha-icon-display is no theme
    // token but ha-svg-icon's own hook, which nothing sets by default.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TemplateElement[value.raw=/var\\(\\s*--ha-(?!icon-display\\s*,)[\\w-]+\\s*,/]",
          message:
            "Use var(--ha-…) without a fallback: src/styles.css sets every theme token.",
        },
        {
          selector:
            "Literal[value=/var\\(\\s*--ha-(?!icon-display\\s*,)[\\w-]+\\s*,/]",
          message:
            "Use var(--ha-…) without a fallback: src/styles.css sets every theme token.",
        },
      ],
    },
  },
  {
    // State is what views read and write, so it can't depend on them, not even
    // for a type: the dependency would run both ways.
    files: ["src/state/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/views/**", "**/components/**"],
              message:
                "src/state must not import views or components; move what it needs into src/state.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ["dist/", "node_modules/", "crates/"],
  },
  {
    files: ["test/unit/**/*.ts"],
    plugins: {
      "chai-friendly": chaiFriendly,
    },
    languageOptions: {
      globals: globals.mocha,
    },
    rules: {
      "@typescript-eslint/no-unused-expressions": "off",
      "chai-friendly/no-unused-expressions": "error",
    },
  },
];
