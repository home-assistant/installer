import { css } from "lit";
import { reducedMotionStyles } from "../../utils/view-accessibility.js";

/** Layout shared by the live USB screens, matching the other wizard views. */
export const liveUsbStyles = css`
  ${reducedMotionStyles}
  :host {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-height: 100%;
  }

  h2 {
    font-size: 1.5rem;
    font-weight: 400;
    color: var(--ha-text-color);
    margin: 0 0 0.5rem 0;
    text-align: center;
  }

  .subtitle {
    font-size: 1rem;
    color: var(--ha-secondary-text-color);
    margin: 0 0 1.5rem 0;
    text-align: center;
    max-width: 500px;
  }

  .card {
    width: 100%;
    max-width: 500px;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .notice {
    width: 100%;
    max-width: 500px;
    padding: 1rem;
    border-radius: 8px;
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--ha-text-color);
    background-color: var(--ha-warning-background);
    border: 1px solid var(--ha-warning-border);
    box-sizing: border-box;
  }

  .notice.error {
    background-color: var(--ha-error-background);
    border-color: var(--ha-error-border);
  }

  .notice p {
    margin: 0 0 0.75rem 0;
  }

  .notice p:last-child {
    margin-bottom: 0;
  }

  code {
    overflow-wrap: anywhere;
  }
`;
