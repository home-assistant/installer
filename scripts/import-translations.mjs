// Copies the catalogs of a Lokalise export next to en.json, each named after
// a tag the app looks up (src/localization/initialize.ts). CI runs
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
  const catalogs = new Map();
  for (const filename of fs.readdirSync(exportFolder)) {
    if (!filename.endsWith(".json")) continue;
    const exportPath = path.join(exportFolder, filename);
    const catalog = JSON.parse(fs.readFileSync(exportPath, "utf8"));
    // An empty pt_PT mustn't take pt from pt_BR
    if (Object.keys(catalog).length)
      catalogs.set(path.basename(filename, ".json"), exportPath);
  }
  const codes = [...catalogs.keys()];
  for (const [code, exportPath] of catalogs) {
    const name = catalogName(code, codes);
    if (name)
      fs.copyFileSync(exportPath, path.join(catalogFolder, `${name}.json`));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  importTranslations(
    process.argv[2],
    process.argv[3] ?? path.join(root, "src/localization")
  );
}
