import { isTauri } from "@tauri-apps/api/core";
import { locale } from "@tauri-apps/plugin-os";
import { ReactiveElement } from "lit";
import { getLanguageOverride } from "../api/commands.js";
import {
  type Catalog,
  getLanguage,
  localize,
  setLanguage,
} from "./localize.js";

// Each translation next to en.json is its own chunk. English is bundled.
const catalogs = import.meta.glob<Catalog>(["./*.json", "!./en.json"], {
  import: "default",
});

const loadCatalog = async (name: string): Promise<Catalog | null> =>
  (await catalogs[`./${name}.json`]?.()) ?? null;

/** The languages with a catalog, by the tag it is named after */
export function shippedLanguages(): string[] {
  return [
    "en",
    ...Object.keys(catalogs).map((path) => path.slice(2, -".json".length)),
  ];
}

// HAI_LANGUAGE stands in for the OS locale
const osLocale = async () => (await getLanguageOverride()) ?? locale();

// The exact catalog first, then the script's, like zh-Hant for zh-TW, then
// the base language's, like de for de-AT
function catalogNames(tag: Intl.Locale): string[] {
  const { language, script } = tag.maximize();
  const written = script ? `${language}-${script}` : language;
  return [...new Set([tag.baseName, written, language])];
}

/** Which of `shippedLanguages()` the UI shows */
export function shownLanguage(): string {
  const shipped = shippedLanguages();
  return (
    catalogNames(new Intl.Locale(getLanguage())).find((name) =>
      shipped.includes(name)
    ) ?? "en"
  );
}

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
    // The tag keeps its region either way, for Intl formatting
    for (const name of catalogNames(tag)) {
      // English is bundled
      const catalog = name === "en" ? {} : await optional(() => load(name));
      if (catalog) return setLanguage(tag.toString(), catalog);
    }
  }
  setLanguage("en");
}

function showLanguage(): void {
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

// Components localize as they render, so rendering again translates them
function renderAgain(root: ParentNode): void {
  for (const element of root.querySelectorAll("*")) {
    if (element instanceof ReactiveElement) element.requestUpdate();
    if (element.shadowRoot) renderAgain(element.shadowRoot);
  }
}

export async function initializeLocalization(): Promise<void> {
  await detectLanguage(navigator.languages, isTauri() ? osLocale : undefined);
  showLanguage();
}

// One choice at a time: a catalog that loads slowly must not replace a later
// choice
let choosing = Promise.resolve();

/** Shows the running UI in one of `shippedLanguages()` */
export function chooseLanguage(name: string): Promise<void> {
  choosing = choosing.then(async () => {
    await detectLanguage([name]);
    showLanguage();
    renderAgain(document);
  });
  return choosing;
}
