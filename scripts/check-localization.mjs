import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntlMessageFormat } from "intl-messageformat";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
// Tests pass a temporary catalog so negative checks never modify source files.
const catalog = JSON.parse(
  fs.readFileSync(
    process.argv[2] ?? path.join(root, "src/localization/en.json"),
    "utf8"
  )
);
const parameters = new Map();
for (const [key, message] of Object.entries(catalog)) {
  assert.equal(typeof message, "string", `${key}: messages must be plain text`);
  assert(
    !/<\/?[a-z][^>]*>/i.test(message),
    `${key}: HTML belongs in Lit, not the catalog`
  );
  const names = new Set();
  function visit(elements) {
    for (const element of elements) {
      if (element.type !== 0 && element.type !== 7) names.add(element.value);
      if (element.options)
        Object.values(element.options).forEach((option) => visit(option.value));
    }
  }
  visit(
    new IntlMessageFormat(message, "en", undefined, {
      ignoreTag: true,
    }).getAst()
  );
  parameters.set(key, [...names].sort());
}

const used = new Set();
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(filename);
      continue;
    }
    if (!filename.endsWith(".ts")) continue;
    const source = ts.createSourceFile(
      filename,
      fs.readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["localize", "localizeContent"].includes(node.expression.text)
      ) {
        const [key, values] = node.arguments;
        assert(
          key && ts.isStringLiteral(key),
          `${filename}: localization keys must be static`
        );
        assert(
          parameters.has(key.text),
          `${filename}: unknown key ${key.text}`
        );
        assert(
          !values || ts.isObjectLiteralExpression(values),
          `${key.text}: placeholders must be explicit`
        );
        const supplied = values
          ? values.properties
              .map((property) => {
                assert(
                  ts.isPropertyAssignment(property) ||
                    ts.isShorthandPropertyAssignment(property),
                  `${key.text}: placeholder spreads are not supported`
                );
                assert(
                  ts.isIdentifier(property.name) ||
                    ts.isStringLiteral(property.name),
                  `${key.text}: placeholder names must be static`
                );
                return property.name.text;
              })
              .sort()
          : [];
        assert.deepEqual(
          supplied,
          parameters.get(key.text),
          `${filename}: ${key.text} placeholder mismatch`
        );
        used.add(key.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
walk(path.join(root, "src"));
assert.deepEqual(
  [...parameters.keys()].filter((key) => !used.has(key)),
  [],
  "Unused catalog messages"
);
console.log(
  `Checked ${used.size} catalog messages and every source placeholder contract.`
);
