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

test("a language with nothing translated doesn't count", () => {
  const script = fileURLToPath(
    new URL("./import-translations.mjs", import.meta.url)
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hai-lokalise-"));
  try {
    const exported = path.join(directory, "export");
    const catalogs = path.join(directory, "catalogs");
    fs.mkdirSync(exported);
    fs.mkdirSync(catalogs);
    const write = (code, catalog) =>
      fs.writeFileSync(
        path.join(exported, `${code}.json`),
        JSON.stringify(catalog)
      );
    write("en", { "common.next": "Next" });
    write("pt_BR", { "common.next": "Próximo" });
    write("pt_PT", {});
    write("de", {});
    write("de_AT", { "common.next": "Weiter" });
    write("zh_CN", { "common.next": "下一步" });

    const result = spawnSync(process.execPath, [script, exported, catalogs], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(catalogs).sort(), [
      "de.json",
      "pt.json",
      "zh-Hans.json",
    ]);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(catalogs, "pt.json"), "utf8")),
      { "common.next": "Próximo" }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
