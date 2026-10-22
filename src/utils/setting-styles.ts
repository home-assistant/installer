import { css } from "lit";

/** A labelled setting with an icon and a description below it, as the VM settings show them. */
export const settingStyles = css`
  .setting-row {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .setting-icon {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-top: 2px;
  }

  .setting-icon svg {
    width: 22px;
    height: 22px;
    fill: var(--ha-secondary-text-color, #727272);
  }

  .setting-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }

  wa-slider::part(label) {
    display: block;
  }

  .setting-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .setting-label {
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--ha-text-color, #212121);
  }

  .setting-value {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--ha-primary-color, #03a9f4);
    min-width: 70px;
    text-align: right;
  }

  .setting-description {
    font-size: 0.75rem;
    color: var(--ha-secondary-text-color, #9e9e9e);
    margin: 0;
    line-height: 1.3;
  }

  /* The slider's handle reaches below its track */
  wa-slider::part(hint) {
    margin-block-start: 1rem;
  }
`;
