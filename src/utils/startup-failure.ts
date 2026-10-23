import { localize } from "../localization/localize.js";
import { BUG_REPORT_URL, logFrontendError } from "./diagnostics.js";
import { openExternalLink } from "./external-url.js";

/**
 * What the window shows when the app shell fails to load, instead of staying
 * blank. Plain DOM, because Lit or Web Awesome may be what failed. index.html
 * links styles.css itself, so its tokens still apply. localize() shows the
 * English when the user's language didn't load.
 */
export function showStartupFailure(error: unknown) {
  logFrontendError(error);
  // The log keeps only a category; the developer tools get the stack
  console.error(error);

  const heading = document.createElement("h1");
  heading.textContent = localize("utils.startup_failure.title");
  heading.style.cssText =
    "margin: 0 0 0.5rem; font-size: 1.75rem; font-weight: 400";

  const description = document.createElement("p");
  description.textContent = localize("utils.startup_failure.description");
  description.style.cssText =
    "margin: 0 0 1rem; color: var(--ha-secondary-text-color)";

  const link = document.createElement("a");
  link.href = BUG_REPORT_URL;
  link.textContent = localize("utils.startup_failure.report");
  link.style.color = "var(--ha-primary-color)";
  link.addEventListener("click", (event) => void openExternalLink(event));
  const report = document.createElement("p");
  report.style.margin = "0";
  report.append(link);

  // The auto margins center the message, and let it scroll from the top
  // once it doesn't fit
  const content = document.createElement("div");
  content.style.cssText = "margin: auto; max-width: 32rem; text-align: center";
  content.append(heading, description, report);
  const main = document.createElement("main");
  main.style.cssText =
    "display: flex; height: 100%; overflow: auto; padding: var(--ha-page-gutter)";
  main.append(content);
  document.body.replaceChildren(main);
}
