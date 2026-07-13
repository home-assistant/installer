// HAI - Home Assistant Installer
// Main entry point

import "@home-assistant/webawesome/dist/styles/themes/default.css";
import "./components/app-shell.js";

// Web Awesome's dark theme is gated on a `wa-dark` class rather than
// prefers-color-scheme, so sync it with the OS color scheme ourselves. This
// keeps every Web Awesome component (button hover states, tooltips, dialogs)
// correct in dark mode instead of only the tokens we override in styles.css.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const applyWaTheme = (isDark: boolean) => {
  document.documentElement.classList.toggle("wa-dark", isDark);
};
applyWaTheme(darkQuery.matches);
darkQuery.addEventListener("change", (event) => applyWaTheme(event.matches));
