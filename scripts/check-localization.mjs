import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntlMessageFormat } from "intl-messageformat";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
// Tests pass a temporary catalog so negative checks never modify source files.
// Its translations are the other JSON files in the same folder.
const catalogPath =
  process.argv[2] ?? path.join(root, "src/localization/en.json");
const read = (filename) => JSON.parse(fs.readFileSync(filename, "utf8"));

function placeholders(key, message) {
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
  let ast;
  try {
    ast = new IntlMessageFormat(message, "en", undefined, {
      ignoreTag: true,
    }).getAst();
  } catch (error) {
    assert.fail(`${key}: ${error.message}`);
  }
  visit(ast);
  return [...names].sort();
}

const parameters = new Map();
for (const [key, message] of Object.entries(read(catalogPath))) {
  const names = placeholders(key, message);
  for (const name of names) {
    assert(
      !/^value\d+$/.test(name),
      `${key}: name the {${name}} placeholder after what it holds`
    );
  }
  parameters.set(key, names);
}

// A translation may lack keys, but every message it has must fit the English
for (const filename of fs.readdirSync(path.dirname(catalogPath))) {
  if (!filename.endsWith(".json") || filename === path.basename(catalogPath))
    continue;
  // The app looks a catalog up by its canonical tag, like pt-BR
  const language = path.basename(filename, ".json");
  let tag;
  try {
    tag = new Intl.Locale(language).baseName;
  } catch {
    // Reported below
  }
  assert.equal(
    tag,
    language,
    `${filename}: name a catalog after its language tag, like pt-BR.json`
  );
  const translation = read(path.join(path.dirname(catalogPath), filename));
  for (const [key, message] of Object.entries(translation)) {
    assert(parameters.has(key), `${filename}: unknown key ${key}`);
    // An export can list untranslated keys with empty text
    if (typeof message === "string" && !message.trim()) continue;
    assert.deepEqual(
      placeholders(`${filename}: ${key}`, message),
      parameters.get(key),
      `${filename}: ${key} placeholder mismatch`
    );
  }
}

// A key under a file's namespace (views.sbc.success_view.title for
// src/views/sbc/success-view.ts) belongs to that file. In Lokalise the key is
// a translator's main hint where a string appears; one shared by several
// screens goes under common.* instead, and the Rust code names backend.*.
// Every key starts with one of these, so none escapes the rule.
const FILE_NAMESPACES = ["views.", "components.", "utils.", "api.", "state."];
for (const key of parameters.keys()) {
  assert(
    ["common.", "backend.", ...FILE_NAMESPACES].some((prefix) =>
      key.startsWith(prefix)
    ),
    `${key}: unknown namespace. Use the namespace of the file that uses it, or common.* when several screens share it`
  );
}
// Tests pass a temporary source folder to check a misplaced key.
const sourceRoot = process.argv[3] ?? path.join(root, "src");
function fileNamespace(filename) {
  return path
    .relative(sourceRoot, filename)
    .replace(/\.ts$/, "")
    .split(path.sep)
    .map((part) => part.replaceAll("-", "_"))
    .join(".");
}

// Code that runs when the module loads cannot localize: the text would be
// fixed before the language is known and never follow a change of it.
// Functions and instance fields run later, once the app is up.
function runsLater(node) {
  return (
    ts.isFunctionLike(node) ||
    (ts.isPropertyDeclaration(node) &&
      !(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static))
  );
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
    function visit(node, deferred = false) {
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
          deferred,
          `${filename}: ${key.text} is localized when the module loads. Localize when the text is shown, in render() or in a function it calls`
        );
        assert(
          parameters.has(key.text),
          `${filename}: unknown key ${key.text}`
        );
        if (FILE_NAMESPACES.some((prefix) => key.text.startsWith(prefix))) {
          assert.equal(
            key.text.slice(0, key.text.lastIndexOf(".")),
            fileNamespace(filename),
            `${filename}: ${key.text} belongs to another file. Use this file's namespace, or common.* when several screens share it`
          );
        }
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
      ts.forEachChild(node, (child) => {
        visit(child, deferred || runsLater(node));
      });
    }
    visit(source);
  }
}
walk(sourceRoot);

// Backend messages are named in Rust with message!(key, name = value, ...).
// Only those calls count, outside comments and test modules, and their
// parameters have to match the catalog's placeholders.
function messageCalls(source) {
  const calls = [];
  for (const match of source.matchAll(/\bmessage!\(/g)) {
    const args = [];
    let depth = 0;
    let current = "";
    let quoted = false;
    for (
      let index = match.index + match[0].length;
      index < source.length;
      index++
    ) {
      const char = source[index];
      if (quoted) {
        current += char;
        if (char === "\\") current += source[++index];
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if ("([{".includes(char)) depth++;
      else if (")]}".includes(char)) {
        if (depth === 0) break;
        depth--;
      } else if (char === "," && depth === 0) {
        args.push(current.trim());
        current = "";
        continue;
      }
      current += char;
    }
    args.push(current.trim());
    calls.push(args.filter(Boolean));
  }
  return calls;
}

function walkRust(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkRust(filename);
      continue;
    }
    if (!filename.endsWith(".rs")) continue;
    const source = fs
      .readFileSync(filename, "utf8")
      // Test modules sit at the end of a file
      .split(/^#\[cfg\(test\)\]\s*mod /m)[0]
      .replace(/^\s*\/\/.*$/gm, "");
    for (const [literal, ...params] of messageCalls(source)) {
      const key = /^"(backend\.[a-z0-9_.]+)"$/.exec(literal)?.[1];
      assert(key, `${filename}: message keys must be backend.* literals`);
      assert(parameters.has(key), `${filename}: unknown key ${key}`);
      const supplied = params
        .map((param) => {
          const name = /^([a-z_][a-z0-9_]*)\s*=[^=]/.exec(param)?.[1];
          assert(name, `${key}: parameters must be name = value`);
          return name;
        })
        .sort();
      assert.deepEqual(
        supplied,
        parameters.get(key),
        `${filename}: ${key} placeholder mismatch`
      );
      used.add(key);
    }
  }
}
walkRust(path.join(root, "crates"));
assert.deepEqual(
  [...parameters.keys()].filter((key) => !used.has(key)),
  [],
  "Unused catalog messages"
);
console.log(
  `Checked ${used.size} catalog messages and every source placeholder contract.`
);
