import { IntlMessageFormat, type PrimitiveType } from "intl-messageformat";
import messages from "./en.json";

export type MessageKey = keyof typeof messages;

let language = "en";
const formatters = new Map<MessageKey, IntlMessageFormat>();

export function resolveLanguage(preferences: readonly string[]): string {
  for (const preference of preferences) {
    try {
      const [locale] = Intl.getCanonicalLocales(preference);
      // English is the only shipped catalog. Preserve its regional formatting.
      if (locale?.split("-")[0] === "en") return locale;
    } catch {
      // Invalid OS/browser locale tags must not prevent startup.
    }
  }
  return "en";
}

export function setLanguage(preferences: readonly string[]): void {
  language = resolveLanguage(preferences);
  formatters.clear();
}

export function getLanguage(): string {
  return language;
}

function formatter(key: MessageKey): IntlMessageFormat {
  let result = formatters.get(key);
  if (!result) {
    // Catalog values are text, never HTML. Rich placeholders come from Lit code.
    result = new IntlMessageFormat(messages[key], language, undefined, {
      ignoreTag: true,
    });
    formatters.set(key, result);
  }
  return result;
}

export function localize(
  key: MessageKey,
  values?: Record<string, PrimitiveType>
): string {
  return formatter(key).format(values) as string;
}

export function localizeContent(
  key: MessageKey,
  values?: Record<string, unknown>
): unknown {
  return formatter(key).format<unknown>(values);
}

export function formatNumber(
  value: number,
  options: Intl.NumberFormatOptions = {}
): string {
  return new Intl.NumberFormat(language, options).format(value);
}
