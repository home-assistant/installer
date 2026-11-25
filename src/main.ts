// HAI - Home Assistant Installer
// Main entry point

import "@home-assistant/webawesome/dist/styles/themes/default.css";
import { initializeLocalization } from "./localization/initialize.js";
import { installErrorLogging } from "./utils/diagnostics.js";
import { preventReload } from "./utils/reload-guard.js";
import { showStartupFailure } from "./utils/startup-failure.js";
import { initializeTextSize } from "./utils/text-size.js";
import { initializeTheme } from "./utils/theme.js";

installErrorLogging();
initializeTextSize();
initializeTheme();

// A developer reloads on purpose, and the browser mocks start over with it
if (!import.meta.env.DEV) preventReload();

// Initialize before component modules capture labels; failure still loads the UI.
// A module that fails to load would leave the window blank.
void initializeLocalization()
  .catch(() => undefined)
  .then(() => import("./components/app-shell.js"))
  .catch(showStartupFailure);
