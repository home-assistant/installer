import { css } from "lit";

/**
 * The box around a step's main content, such as a form, a summary or a
 * status: a column of the same width as the cards other steps list. These
 * are the declarations, for the rule of the element that is the box, as in
 * `.summary-card { ${panelStyles} }`. That rule may add to them, or change
 * the spacing where its content needs another.
 */
export const panelStyles = css`
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  padding: 1.5rem;
  background-color: var(--ha-card-background);
  border: 1px solid var(--ha-border-color);
  border-radius: var(--ha-card-border-radius);
  width: 100%;
  box-sizing: border-box;
  max-width: var(--ha-content-width);
`;
