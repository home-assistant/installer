import { css } from "lit";

/**
 * A choice between a few options, as `option-card`s in a container of class
 * `options`. Side by side, and stacked on narrow windows.
 */
export const optionCardStyles = css`
  .options {
    display: flex;
    gap: 1rem;
    width: 100%;
    max-width: 700px;
  }

  .options option-card {
    flex: 1;
    min-width: 0;
  }

  @media (max-width: 500px) {
    .options {
      flex-direction: column;
    }
  }
`;
