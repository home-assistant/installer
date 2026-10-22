import { css } from "lit";

/**
 * A choice between a few options, as a `wa-radio-group` of class `options`
 * whose `wa-radio` buttons are cards with an `.option-icon`, `.option-title`
 * and `.option-description`. Side by side, and stacked on narrow windows.
 */
export const optionCardStyles = css`
  .options {
    display: block;
    width: 100%;
    max-width: 700px;
  }

  .options::part(form-control-label) {
    display: none;
  }

  .options::part(form-control-input) {
    display: flex;
    gap: 1rem;
  }

  @media (max-width: 500px) {
    .options::part(form-control-input) {
      flex-direction: column;
    }
  }

  wa-radio {
    position: relative;
    flex: 1;
    min-width: 0;
    height: auto;
    padding: 1.5rem;
    border-radius: var(--ha-card-border-radius, 12px);
    align-items: flex-start;
  }

  wa-radio::part(label) {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    white-space: normal;
    gap: 0.75rem;
  }

  .option-icon {
    width: 48px;
    height: 48px;
  }

  .option-icon svg {
    width: 100%;
    height: 100%;
    fill: var(--ha-primary-color, #03a9f4);
  }

  .option-title {
    font-size: 1.125rem;
    font-weight: 500;
    color: var(--ha-text-color, #212121);
    margin: 0 0 0.25rem 0;
  }

  /* The control shade of secondary text stays readable on the selected
   * card's tinted fill */
  .option-description {
    font-size: 0.875rem;
    color: var(--ha-control-secondary-text-color, #686868);
    margin: 0;
    line-height: 1.4;
  }
`;
