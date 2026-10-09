import { isTauri } from "@tauri-apps/api/core";
import { locale } from "@tauri-apps/plugin-os";
import { getLanguage, localize, setLanguage } from "./localize.js";

export async function detectLanguage(
  browserLanguages: readonly string[],
  readNativeLocale?: () => Promise<string | null>
): Promise<void> {
  let nativeLocale: string | null = null;
  if (readNativeLocale) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      nativeLocale = await Promise.race([
        readNativeLocale(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1000);
        }),
      ]);
    } catch {
      // Locale discovery is optional; the English UI must still start.
    } finally {
      clearTimeout(timer);
    }
  }
  setLanguage(
    nativeLocale ? [nativeLocale, ...browserLanguages] : browserLanguages
  );
}

export async function initializeLocalization(): Promise<void> {
  await detectLanguage(navigator.languages, isTauri() ? locale : undefined);
  document.documentElement.lang = getLanguage();
  document.title = localize("app.title");
}
