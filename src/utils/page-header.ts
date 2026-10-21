import { css } from "lit";

/**
 * The bar holding Back at the top of a screen. The install flow and the
 * screens before it share it, so Back never moves between them.
 */
export const pageHeaderStyles = css`
  .header {
    display: flex;
    align-items: center;
    padding: 1rem 2rem;
  }

  @media (max-width: 600px) {
    .header {
      padding: 1rem;
    }
  }
`;
