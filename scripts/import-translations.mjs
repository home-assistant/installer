// Copies the catalogs of a Lokalise export next to en.json, each named after
// a tag the app looks up (src/localization/initialize.ts), without the
// translations of English other than en.json's. CI runs
// check-localization.mjs on them afterwards.
//
// Usage: node scripts/import-translations.mjs <export folder> [catalog folder]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// zh_CN and zh_TW after their script, a language's only regional variant,
// like pt_BR or es_419, after the language so every region finds it, and the
// rest with - for _. Other Chinese regions keep theirs, so Simplified and
// Traditional don't mix. `codes` are the exported languages with anything
// translated. English is null: the repository has its own.
export function catalogName(code, codes) {
  if (code === "en") return null;
  if (code === "zh_CN") return "zh-Hans";
  if (code === "zh_TW") return "zh-Hant";
  const language = /^([a-z]+)_(?:[A-Z]{2}|\d{3})$/.exec(code)?.[1];
  if (
    language &&
    language !== "zh" &&
    !codes.includes(language) &&
    codes.filter((other) => other.startsWith(`${language}_`)).length === 1
  )
    return language;
  return code.replaceAll("_", "-");
}

export function importTranslations(exportFolder, catalogFolder) {
  const read = (filename) => JSON.parse(fs.readFileSync(filename, "utf8"));
  const catalogs = new Map(
    fs
      .readdirSync(exportFolder)
      .filter((filename) => filename.endsWith(".json"))
      .map((filename) => [
        path.basename(filename, ".json"),
        read(path.join(exportFolder, filename)),
      ])
  );
  // Once main has moved on, like for a re-run of an older run, Lokalise has
  // newer English than this commit, and its translations mustn't ship next
  // to the old English. A key only one of them has is left to the checker.
  const english = read(path.join(catalogFolder, "en.json"));
  const lokalise = catalogs.get("en") ?? {};
  let stale = 0;
  for (const [code, catalog] of catalogs) {
    if (code === "en") continue;
    for (const key of Object.keys(catalog)) {
      if (
        Object.hasOwn(english, key) &&
        Object.hasOwn(lokalise, key) &&
        lokalise[key] !== english[key]
      ) {
        delete catalog[key];
        stale++;
      }
    }
  }
  if (stale)
    console.log(
      `::notice::Left out ${stale} translations whose English in Lokalise differs from this commit's`
    );
  // An empty pt_PT mustn't take pt from pt_BR
  const codes = [...catalogs.keys()].filter(
    (code) => Object.keys(catalogs.get(code)).length
  );
  for (const code of codes) {
    const name = catalogName(code, codes);
    if (name)
      fs.writeFileSync(
        path.join(catalogFolder, `${name}.json`),
        JSON.stringify(catalogs.get(code), null, 2)
      );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  importTranslations(
    process.argv[2],
    process.argv[3] ?? path.join(root, "src/localization")
  );
}
