import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { catalogName } from "./import-translations.mjs";

test("catalogs are named after a tag the app looks up", () => {
  for (const [code, codes, name] of [
    ["en", ["en", "de"], null],
    ["de", ["en", "de"], "de"],
    ["zh_CN", ["zh_CN", "zh_TW"], "zh-Hans"],
    ["zh_TW", ["zh_TW"], "zh-Hant"],
    // Traditional Chinese for Hong Kong mustn't serve zh-Hans
    ["zh_HK", ["zh_HK"], "zh-HK"],
    // A language's only regional variant serves every region
    ["pt_BR", ["en", "pt_BR"], "pt"],
    ["es_419", ["en", "es_419"], "es"],
    ["pt_BR", ["pt_BR", "pt_PT"], "pt-BR"],
    ["de_AT", ["de", "de_AT"], "de-AT"],
    ["sr_Latn", ["sr_Latn"], "sr-Latn"],
  ]) {
    assert.equal(catalogName(code, codes), name, `${code} among ${codes}`);
  }
});

// Runs the script on an export and returns the catalogs it leaves next to
// `english`, by filename
function importExport(exported, english) {
  const script = fileURLToPath(
    new URL("./import-translations.mjs", import.meta.url)
  );
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
    fs.writeFileSync(
      path.join(catalogFolder, "en.json"),
      JSON.stringify(english)
    );
    const result = spawnSync(
      process.execPath,
      [script, exportFolder, catalogFolder],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
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
    return { stdout: result.stdout, catalogs };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("a language with nothing translated doesn't count", () => {
  const english = { "common.next": "Next" };
  const { stdout, catalogs } = importExport(
    {
      en: english,
      pt_BR: { "common.next": "Próximo" },
      pt_PT: {},
      de: {},
      de_AT: { "common.next": "Weiter" },
      zh_CN: { "common.next": "下一步" },
    },
    english
  );
  assert.deepEqual(catalogs, {
    "de.json": { "common.next": "Weiter" },
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
    "pt.json": { "common.back": "Voltar" },
  });
  assert.match(stdout, /::notice::Left out 2 translations/);
});
