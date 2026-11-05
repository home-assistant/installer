import { css, html } from "lit";

/**
 * A wizard step: a centered column under the step's heading. Every step
 * renders that heading with renderStepHeading(), so the steps keep one size,
 * color and spacing for it.
 */
export const stepStyles = css`
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

  /* As wide as the column most steps put below it */
  .subtitle {
    font-size: 1rem;
    color: var(--ha-secondary-text-color);
    margin: 0 0 1.5rem 0;
    text-align: center;
    max-width: var(--ha-content-width);
  }
`;

/** A step's title and the line under it saying what the step is for. */
export function renderStepHeading(title: string, subtitle: string) {
  return html`
    <h2>${title}</h2>
    <p class="subtitle">${subtitle}</p>
  `;
}
