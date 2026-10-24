import { css, html, nothing } from "lit";
import { localize } from "../localization/localize.js";
import {
  mdiAlert,
  mdiAlertCircle,
  mdiCheckCircle,
  mdiCloseCircle,
} from "./icons.js";
import { renderErrorHelp, type InstallerError } from "./installer-error.js";
import { renderIcon } from "./render-icon.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "../components/loading-spinner.js";

/**
 * A step waiting for what it needs, or telling why it couldn't get it. Every
 * step that loads something renders these the same way, with
 * renderLoading() and renderLoadError().
 */
export const loadStateStyles = css`
  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 3rem;
    color: var(--ha-secondary-text-color);
  }

  .loading loading-spinner {
    font-size: 40px;
    --track-width: 3px;
    --track-color: var(--ha-border-color);
    --indicator-color: var(--ha-primary-color);
  }

  .error {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 2rem;
    text-align: center;
  }

  .error-icon {
    width: 48px;
    height: 48px;
    margin-bottom: 1rem;
    fill: var(--ha-error-color);
  }

  .error-message {
    color: var(--ha-error-color);
    margin-bottom: 1rem;
    overflow-wrap: anywhere;
  }
`;

/** What a step shows until its first result is in. */
export function renderLoading(label: string) {
  // The text says what it waits for; the spinner adds nothing to read out
  return html`
    <div class="loading">
      <loading-spinner aria-hidden="true"></loading-spinner>
      <span>${label}</span>
    </div>
  `;
}

/**
 * Try again, for anything that failed and may work a second time. It stays
 * where it is, busy, while it retries, so it keeps the focus; whoever
 * renders it moves the focus on if the result takes its place.
 */
export function renderRetryButton(
  retrying: boolean,
  onRetry: () => unknown,
  { className = "", disabled = false } = {}
) {
  return html`
    <wa-button
      class=${className}
      variant="brand"
      appearance="outlined"
      ?disabled=${disabled}
      ?loading=${retrying}
      @click=${onRetry}
      >${localize("common.try_again")}</wa-button
    >
  `;
}

/** What a load error offers when trying again can't fix it */
export interface LoadErrorAction {
  label: string;
  onAction: () => unknown;
}

/**
 * Why a step couldn't load what it needs. While it retries, the error stays
 * with Try again busy, and the message is empty, so the same failure is read
 * out again if it comes back. An error that only something else fixes, like
 * logging in again, offers that `action` in place of Try again.
 */
export function renderLoadError(
  error: InstallerError,
  retrying: boolean,
  onRetry: () => unknown,
  { action }: { action?: LoadErrorAction } = {}
) {
  return html`
    <div class="error">
      ${renderIcon(mdiAlert, "error-icon")}
      <p class="error-message" data-focus-alert>
        ${retrying ? "" : error.message}
      </p>
      ${renderErrorHelp()}
      ${action
        ? html`<wa-button variant="brand" @click=${action.onAction}
            >${action.label}</wa-button
          >`
        : error.retryable
          ? renderRetryButton(retrying, onRetry)
          : ""}
    </div>
  `;
}

/** What a status row reports, which picks its icon and color. */
export type StatusKind = "loading" | "success" | "warning" | "error";

// The mark is cut out of the circle, so it shows what is under it in either
// theme.
const statusIcons: Record<Exclude<StatusKind, "loading">, string> = {
  success: mdiCheckCircle,
  warning: mdiAlertCircle,
  error: mdiCloseCircle,
};

/**
 * A check on a step's card, as one line with an icon: under way, what it
 * found, or why it failed. Every step that checks something this way renders
 * it with renderStatusRow().
 */
export const statusRowStyles = css`
  .status-row {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    text-align: start;
  }

  /* Set apart like an error notice, so it isn't taken for a result */
  .status-row.status-error {
    width: 100%;
    box-sizing: border-box;
    padding: 1rem;
    border-radius: var(--ha-small-border-radius);
    background-color: var(--ha-error-background);
    border: 1px solid var(--ha-error-border);
  }

  /* As tall as the title's first line, which it stands next to */
  .status-icon,
  .status-row loading-spinner {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
  }

  .status-icon {
    fill: currentColor;
  }

  .status-success .status-icon {
    color: var(--ha-success-color);
  }

  .status-warning .status-icon {
    color: var(--ha-warning-color);
  }

  .status-error .status-icon {
    color: var(--ha-error-color);
  }

  .status-row loading-spinner {
    font-size: 24px;
    --track-width: 2px;
    --track-color: var(--ha-border-color);
    --indicator-color: var(--ha-primary-color);
  }

  .status-text {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .status-title {
    font-size: 1rem;
    font-weight: 500;
    color: var(--ha-text-color);
    margin: 0;
  }

  .status-description {
    font-size: 0.8125rem;
    color: var(--ha-secondary-text-color);
    margin: 0;
  }

  .status-error .status-description {
    color: var(--ha-error-color);
  }

  .status-text .error-help {
    margin: 0.5rem 0 0;
  }
`;

/**
 * One line of a check: a spinner while it runs, then what it found. An error
 * also links to help, and takes the focus when it appears, which reads it
 * out. Try again stays outside it, so it can stay, busy, while the error
 * makes way for the check.
 */
export function renderStatusRow(
  kind: StatusKind,
  title: unknown,
  description?: unknown
) {
  const error = kind === "error";
  // The title says how it went; the icon adds nothing to read out
  return html`
    <div class="status-row status-${kind}" ?data-focus-alert=${error}>
      ${kind === "loading"
        ? html`<loading-spinner aria-hidden="true"></loading-spinner>`
        : renderIcon(statusIcons[kind], "status-icon")}
      <div class="status-text">
        <p class="status-title">${title}</p>
        ${description
          ? html`<p class="status-description">${description}</p>`
          : nothing}
        ${error ? renderErrorHelp() : nothing}
      </div>
    </div>
  `;
}
