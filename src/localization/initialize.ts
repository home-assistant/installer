import { isTauri } from "@tauri-apps/api/core";
import { locale } from "@tauri-apps/plugin-os";
import { getLanguageOverride } from "../api/commands.js";
import {
  type Catalog,
  getLanguage,
  localize,
  setLanguage,
} from "./localize.js";

// Vite bundles each catalog next to en.json as its own chunk. It refuses a
// variable import of the importing module's own folder written as `./`.
const loadCatalog = async (name: string): Promise<Catalog> =>
  (await import(`../localization/${name}.json`)).default;

// HAI_LANGUAGE stands in for the OS locale
const osLocale = async () => (await getLanguageOverride()) ?? locale();

// Locale discovery is optional: after an error or a one-second wait, the UI
// starts with what it has.
async function optional<T>(read: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1000);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function detectLanguage(
  browserLanguages: readonly string[],
  readNativeLocale?: () => Promise<string | null>,
  load = loadCatalog
): Promise<void> {
  const nativeLocale = readNativeLocale && (await optional(readNativeLocale));
  const preferences = nativeLocale
    ? [nativeLocale, ...browserLanguages]
    : browserLanguages;
  for (const preference of preferences) {
    let tag: Intl.Locale;
    try {
      tag = new Intl.Locale(preference);
    } catch {
      // Invalid OS/browser locale tags must not prevent startup.
      continue;
    }
    // The exact catalog first, then the script's, like zh-Hant for zh-TW, then
    // the base language's, like de for de-AT. The tag keeps its region either
    // way, for Intl formatting.
    const { language, script } = tag.maximize();
    const written = script ? `${language}-${script}` : language;
    for (const name of new Set([tag.baseName, written, language])) {
      // English is bundled
      const catalog = name === "en" ? {} : await optional(() => load(name));
      if (catalog) return setLanguage(tag.toString(), catalog);
    }
  }
  setLanguage("en");
}

export async function initializeLocalization(): Promise<void> {
  await detectLanguage(navigator.languages, isTauri() ? osLocale : undefined);
  document.documentElement.lang = getLanguage();
  const tag = new Intl.Locale(getLanguage()) as Intl.Locale & {
    getTextInfo?(): { direction: string };
    textInfo?: { direction: string };
  };
  // Web views have either the newer method or the older getter
  document.documentElement.dir =
    (tag.getTextInfo?.() ?? tag.textInfo)?.direction ?? "ltr";
  document.title = localize("common.app_title");
}
