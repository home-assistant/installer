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

  try {
    return formatter(key as MessageKey).format(params) as string;
  } catch {
    // A parameter the catalog expects is missing: the English is better
    return undefined;
  }
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
