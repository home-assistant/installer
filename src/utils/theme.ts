const THEMES = ["system", "light", "dark"] as const;

export type Theme = (typeof THEMES)[number];

export const THEME_CHANGE = "theme-change";

const STORAGE_KEY = "hai:theme";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

let current: Theme = "system";

export function theme(): Theme {
  return current;
}

export function darkTheme(): boolean {
  return current === "dark" || (current === "system" && darkQuery.matches);
}

// Web Awesome's dark theme, and the app's colors in styles.css, follow the
// `wa-dark` class rather than prefers-color-scheme, so a theme chosen in the
// app wins over the OS's
function apply(): void {
  document.documentElement.classList.toggle("wa-dark", darkTheme());
  window.dispatchEvent(new Event(THEME_CHANGE));
}

/** Shows the app in `next` and remembers it for next time */
export function setTheme(next: Theme): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not remembered, but still applied
  }
  apply();
}

/** Restores the last theme, and follows the OS's while it matches the system */
export function initializeTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Matches the system
  }
  current = THEMES.find((theme) => theme === stored) ?? "system";
  apply();
  darkQuery.addEventListener("change", apply);
}
