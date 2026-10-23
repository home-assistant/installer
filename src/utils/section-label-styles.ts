import { css } from "lit";

/**
 * The small uppercase heading over a part of a step, such as the drive list
 * or a row of the install summary. It is an h3 under the step's h2, so a
 * screen reader can move through a step by its parts, but it reads as a
 * label rather than a title. Each place that uses it may set its own size
 * and spacing.
 */
export const sectionLabelStyles = css`
  .section-label {
    font-size: 0.875rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ha-secondary-text-color, #727272);
    margin: 0;
  }
`;
