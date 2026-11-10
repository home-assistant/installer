// Copies the catalogs of a Lokalise export next to en.json, without the
// translations of English other than en.json's. CI then runs
// check-localization.mjs on them, and --regions names what it leaves after a
// tag the app looks up (src/localization/initialize.ts).
//
// Usage: node scripts/import-translations.mjs <export folder> [catalog folder]
//        node scripts/import-translations.mjs --regions [catalog folder]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// zh_CN and zh_TW after their script, the rest with - for _. English is
// null: the repository has its own.
export function catalogTag(code) {
  if (code === "en") return null;
  if (code === "zh_CN") return "zh-Hans";
  if (code === "zh_TW") return "zh-Hant";
  return code.replaceAll("_", "-");
}

// A language's only regional catalog, like pt-BR or es-419, after the
// language so every region finds it. Other Chinese regions keep theirs, so
// Simplified and Traditional don't mix. `tags` are the catalogs the check
// left, so a region it emptied doesn't keep another from its language.
export function catalogName(tag, tags) {
  const language = /^([a-z]+)-(?:[A-Z]{2}|\d{3})$/.exec(tag)?.[1];
  if (
    language &&
    language !== "zh" &&
    !tags.includes(language) &&
    tags.filter((other) => other.startsWith(`${language}-`)).length === 1
  )
    return language;
  return tag;
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
  for (const [code, catalog] of catalogs) {
    const tag = catalogTag(code);
    if (tag)
      fs.writeFileSync(
        path.join(catalogFolder, `${tag}.json`),
        JSON.stringify(catalog, null, 2)
      );
  }
}

export function nameRegions(catalogFolder) {
  // en stays among them, so a lone en-GB can't take en.json's name
  const tags = fs
    .readdirSync(catalogFolder)
    .filter((filename) => filename.endsWith(".json"))
    .map((filename) => path.basename(filename, ".json"));
  for (const tag of tags) {
    const name = catalogName(tag, tags);
    if (name !== tag)
      fs.renameSync(
        path.join(catalogFolder, `${tag}.json`),
        path.join(catalogFolder, `${name}.json`)
      );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const [first, folder = path.join(root, "src/localization")] =
    process.argv.slice(2);
  if (first === "--regions") nameRegions(folder);
  else importTranslations(first, folder);
}
