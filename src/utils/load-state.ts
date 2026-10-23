import { css, html } from "lit";
import { localize } from "../localization/localize.js";
import { renderErrorHelp, type InstallerError } from "./installer-error.js";
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
    color: var(--ha-secondary-text-color, #727272);
  }

  .loading loading-spinner {
    font-size: 40px;
    --track-width: 3px;
    --track-color: var(--ha-border-color, #e0e0e0);
    --indicator-color: var(--ha-primary-color, #03a9f4);
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
    fill: var(--ha-error-color, #db4437);
  }

  .error-message {
    color: var(--ha-error-color, #db4437);
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

/**
 * Why a step couldn't load what it needs. While it retries, the error stays
 * with Try again busy, and the message is empty, so the same failure is read
 * out again if it comes back.
 */
export function renderLoadError(
  error: InstallerError,
  retrying: boolean,
  onRetry: () => unknown
) {
  return html`
    <div class="error">
      <svg class="error-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z" />
      </svg>
      <p class="error-message" role="alert">${retrying ? "" : error.message}</p>
      ${renderErrorHelp()}
      ${error.retryable ? renderRetryButton(retrying, onRetry) : ""}
    </div>
  `;
}
