import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { catalogName, catalogTag } from "./import-translations.mjs";

test("catalogs are named after a tag the app looks up", () => {
  for (const [code, tag] of [
    ["en", null],
    ["de", "de"],
    ["zh_CN", "zh-Hans"],
    ["zh_TW", "zh-Hant"],
    ["pt_BR", "pt-BR"],
    ["es_419", "es-419"],
  ]) {
    assert.equal(catalogTag(code), tag, code);
  }
  for (const [tag, tags, name] of [
    ["de", ["de"], "de"],
    ["zh-Hans", ["zh-Hans", "zh-Hant"], "zh-Hans"],
    // Traditional Chinese for Hong Kong mustn't serve zh-Hans
    ["zh-HK", ["zh-HK"], "zh-HK"],
    // A language's only regional variant serves every region
    ["pt-BR", ["pt-BR"], "pt"],
    ["es-419", ["es-419"], "es"],
    ["pt-BR", ["pt-BR", "pt-PT"], "pt-BR"],
    ["de-AT", ["de", "de-AT"], "de-AT"],
    ["en-GB", ["en", "en-GB"], "en-GB"],
    ["sr-Latn", ["sr-Latn"], "sr-Latn"],
  ]) {
    assert.equal(catalogName(tag, tags), name, `${tag} among ${tags}`);
  }
});

const script = fileURLToPath(
  new URL("./import-translations.mjs", import.meta.url)
);

// Runs CI's steps on an export and returns the catalogs they leave next to
// `english` (the repository's by default), by filename. `check` also runs the
// pruning check between the import and the naming.
function importExport(exported, english, { check = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hai-lokalise-"));
  try {
    const exportFolder = path.join(directory, "export");
    const catalogFolder = path.join(directory, "catalogs");
    fs.mkdirSync(exportFolder);
    fs.mkdirSync(catalogFolder);
    for (const [code, catalog] of Object.entries(exported)) {
      fs.writeFileSync(
        path.join(exportFolder, `${code}.json`),
        JSON.stringify(catalog)
      );
    }
    const catalog = path.join(catalogFolder, "en.json");
    if (english) fs.writeFileSync(catalog, JSON.stringify(english));
    else
      fs.copyFileSync(
        fileURLToPath(new URL("../src/localization/en.json", import.meta.url)),
        catalog
      );
    const run = (args, env) => {
      const result = spawnSync(process.execPath, args, {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const stdout = run([script, exportFolder, catalogFolder]);
    if (check)
      run(
        [
          fileURLToPath(new URL("./check-localization.mjs", import.meta.url)),
          catalog,
        ],
        { LOCALIZATION_PRUNE: "1" }
      );
    run([script, "--regions", catalogFolder]);
    const catalogs = Object.fromEntries(
      fs
        .readdirSync(catalogFolder)
        .filter((filename) => filename !== "en.json")
        .map((filename) => [
          filename,
          JSON.parse(
            fs.readFileSync(path.join(catalogFolder, filename), "utf8")
          ),
        ])
    );
    return { stdout, catalogs };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("a language the check leaves nothing of doesn't count", () => {
  const { stdout, catalogs } = importExport(
    {
      pt_BR: { "common.next": "Próximo" },
      // Only a key en.json doesn't have
      pt_PT: { "common.gone": "Desaparecido" },
      de: {},
      de_AT: { "common.next": "Weiter" },
      zh_CN: { "common.next": "下一步" },
      // The repository's en.json keeps its name
      en_GB: { "common.next": "Next" },
    },
    undefined,
    { check: true }
  );
  assert.deepEqual(catalogs, {
    "de.json": { "common.next": "Weiter" },
    "en-GB.json": { "common.next": "Next" },
    "pt.json": { "common.next": "Próximo" },
    "zh-Hans.json": { "common.next": "下一步" },
  });
  assert.equal(stdout, "");
});

test("translations of other English are left out", () => {
  // Since this commit, main has changed common.next, added common.new and
  // removed common.gone. Lokalise has only main's English.
  const { stdout, catalogs } = importExport(
    {
      en: {
        "common.next": "Continue",
        "common.back": "Back",
        "common.new": "New",
      },
      de: {
        "common.next": "Fortfahren",
        "common.back": "Zurück",
        "common.new": "Neu",
        "common.gone": "Weg",
      },
      pt_BR: { "common.back": "Voltar" },
      pt_PT: { "common.next": "Continuar" },
    },
    { "common.next": "Next", "common.back": "Back", "common.gone": "Gone" }
  );
  // Keys only one English has are the checker's to drop or keep
  assert.deepEqual(catalogs, {
    "de.json": {
      "common.back": "Zurück",
      "common.new": "Neu",
      "common.gone": "Weg",
    },
    "pt-BR.json": { "common.back": "Voltar" },
    "pt-PT.json": {},
  });
  assert.match(stdout, /::notice::Left out 2 translations/);
});
