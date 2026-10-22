import {
  css,
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
} from "lit";
import type { HaosRelease } from "../api/types.js";
import { localize } from "../localization/localize.js";
import { logFrontendError } from "../utils/diagnostics.js";
import { homeAssistantLogo } from "../utils/icons.js";

/** The card the confirm steps sum up an install in, one row per part. */
export const summaryStyles = css`
  .summary-card {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1.5rem;
    background-color: var(--ha-card-background, #ffffff);
    border: 1px solid var(--ha-border-color, #e0e0e0);
    border-radius: 12px;
    width: 100%;
    box-sizing: border-box;
    max-width: 500px;
  }

  .summary-row {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .icon-container {
    width: 64px;
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .icon-container svg {
    width: 36px;
    height: 36px;
    fill: var(--ha-secondary-text-color, #727272);
  }

  .icon-container .ha-icon {
    fill: var(--ha-primary-color, #03a9f4);
  }

  .summary-info {
    flex: 1;
    min-width: 0;
  }

  .summary-label {
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ha-secondary-text-color, #727272);
    margin: 0 0 0.25rem 0;
  }

  .summary-value {
    font-size: 1rem;
    font-weight: 500;
    color: var(--ha-text-color, #212121);
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .summary-detail {
    font-size: 0.875rem;
    color: var(--ha-secondary-text-color, #727272);
    margin: 0.25rem 0 0 0;
  }

  .divider {
    height: 1px;
    background-color: var(--ha-border-color, #e0e0e0);
    margin: 0;
  }
`;

/** A 24 by 24 icon, like the MDI ones, for a summary row */
export function renderSummaryIcon(path: string) {
  return html`
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d=${path} />
    </svg>
  `;
}

/** The Home Assistant logo, in the primary color */
export const haIcon = html`
  <svg
    class="ha-icon"
    viewBox="0 0 240 240"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d=${homeAssistantLogo} />
  </svg>
`;

/**
 * One row of the summary: an icon, what the row is about and its value.
 * `details` go below the value, as `<p class="summary-detail">` lines.
 */
export function renderSummaryRow(
  icon: unknown,
  label: string,
  value: unknown,
  details: unknown = nothing
) {
  return html`
    <div class="summary-row">
      <div class="icon-container">${icon}</div>
      <div class="summary-info">
        <p class="summary-label">${label}</p>
        <p class="summary-value">${value}</p>
        ${details}
      </div>
    </div>
  `;
}

/**
 * The Home Assistant OS row, with the version from `HaosVersion`: loading
 * until it's known, and unknown when it can't be looked up.
 */
export function renderHaosVersionRow(version: string | null | undefined) {
  return renderSummaryRow(
    haIcon,
    localize("common.confirm.home_assistant_operating_system"),
    version === null
      ? localize("common.version_unknown")
      : version
        ? localize("common.confirm.version_summary", {
            version,
          })
        : localize("common.loading"),
    html`<p class="summary-detail">
      ${localize("common.confirm.latest_stable_release")}
    </p>`
  );
}

/**
 * The version of the Home Assistant OS release a confirm step installs,
 * looked up each time the view is shown.
 */
export class HaosVersion implements ReactiveController {
  /** `undefined` while it's looked up, `null` when that failed */
  version?: string | null;

  /** `lookup` returns nothing when the view has no release to show */
  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly lookup: () => Promise<HaosRelease> | undefined
  ) {
    host.addController(this);
  }

  hostConnected() {
    void this._load();
  }

  private async _load() {
    try {
      const release = this.lookup();
      if (!release) return;
      this.version = (await release).version;
    } catch (error) {
      logFrontendError(error);
      this.version = null;
    }
    this.host.requestUpdate();
  }
}
