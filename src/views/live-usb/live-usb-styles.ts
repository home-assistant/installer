import { css } from "lit";
import { reducedMotionStyles } from "../../utils/view-accessibility.js";

/** Layout shared by the live USB screens, matching the other wizard views. */
export const liveUsbStyles = css`
  ${reducedMotionStyles}
  :host {
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 100%;
  }

  h2 {
    font-size: 1.5rem;
    font-weight: 400;
    color: var(--ha-text-color, #212121);
    margin: 0 0 0.5rem 0;
    text-align: center;
  }

  .subtitle {
    font-size: 1rem;
    color: var(--ha-secondary-text-color, #727272);
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
    color: var(--ha-text-color, #212121);
    background-color: rgba(255, 152, 0, 0.1);
    border: 1px solid rgba(255, 152, 0, 0.3);
    box-sizing: border-box;
  }

  .notice.error {
    background-color: rgba(219, 68, 55, 0.1);
    border-color: rgba(219, 68, 55, 0.3);
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

  @media (prefers-color-scheme: dark) {
    .notice {
      background-color: rgba(255, 152, 0, 0.15);
      border-color: rgba(255, 152, 0, 0.4);
    }
    .notice.error {
      background-color: rgba(219, 68, 55, 0.15);
      border-color: rgba(219, 68, 55, 0.4);
    }
  }
`;
