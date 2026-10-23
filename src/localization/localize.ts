import { IntlMessageFormat, type PrimitiveType } from "intl-messageformat";
import messages from "./en.json";

export type MessageKey = keyof typeof messages;
/** A translation of en.json. A key it lacks shows the English. */
export type Catalog = Record<string, unknown>;

let language = "en";
// English text needs English plural rules, even in another language's UI
let english = "en";
let translation: Catalog = {};
const formatters = new Map<string, IntlMessageFormat>();

export function setLanguage(tag: string, catalog: Catalog = {}): void {
  language = tag;
  english = new Intl.Locale(tag).language === "en" ? tag : "en";
  translation = catalog;
  formatters.clear();
}

export function getLanguage(): string {
  return language;
}

function formatter(message: string, locale: string): IntlMessageFormat {
  const id = `${locale}:${message}`;
  let result = formatters.get(id);
  if (!result) {
    // Catalog values are text, never HTML. Rich placeholders come from Lit code.
    result = new IntlMessageFormat(message, locale, undefined, {
      ignoreTag: true,
    });
    formatters.set(id, result);
  }
  return result;
}

function format<T = void>(
  key: MessageKey,
  values?: Record<string, PrimitiveType | T>
): string | T | (string | T)[] {
  const translated = translation[key];
  // An export can list untranslated keys with empty text
  if (typeof translated === "string" && translated.trim()) {
    try {
      return formatter(translated, language).format<T>(values);
    } catch {
      // A broken translation must not hide the English
    }
  }
  return formatter(messages[key], english).format<T>(values);
}

export function localize(
  key: MessageKey,
  values?: Record<string, PrimitiveType>
): string {
  return format(key, values) as string;
}

/**
 * A message the backend named by key, in the user's language. `undefined`
 * when the key isn't a backend message this catalog knows, so the caller
 * can fall back to the backend's English.
 */
export function localizeBackend(
  key: unknown,
  values: unknown
): string | undefined {
  if (
    typeof key !== "string" ||
    !key.startsWith("backend.") ||
    !Object.prototype.hasOwnProperty.call(messages, key)
  ) {
    return undefined;
  }

  const params: Record<string, PrimitiveType> = {};
  if (values && typeof values === "object" && !Array.isArray(values)) {
    for (const [name, value] of Object.entries(values)) {
      if (value && typeof value === "object" && "key" in value) {
        // A message inside the message, like the reason a step failed. If
        // that one can't be shown, neither can the sentence around it.
        const nested = localizeBackend(
          value.key,
          (value as { params?: unknown }).params
        );
        if (nested === undefined) {
          return undefined;
        }
        params[name] = nested;
      } else if (["string", "number"].includes(typeof value)) {
        // Not booleans: intl-messageformat turns those into parts, not text
        params[name] = value as PrimitiveType;
      }
    }
  }

  let text: string;
  try {
    text = format(key as MessageKey, params) as string;
  } catch {
    // A parameter the catalog expects is missing: the English is better
    return undefined;
  }
  // A message that is only a detail, like UTM's "{detail}", can come out
  // empty, and an empty error hides the failure
  return text.trim() ? text : undefined;
}

export function localizeContent(
  key: MessageKey,
  values?: Record<string, unknown>
): unknown {
  return format<unknown>(key, values);
}

export function formatNumber(
  value: number,
  options: Intl.NumberFormatOptions = {}
): string {
  return new Intl.NumberFormat(language, options).format(value);
}
