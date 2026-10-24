import { css } from "lit";
import { veryNarrowWindow } from "./breakpoints.js";

/**
 * A choice between a few options, as `option-card`s in a container of class
 * `options`. Side by side, and stacked on narrow windows.
 */
export const optionCardStyles = css`
  .options {
    display: flex;
    gap: 1rem;
    width: 100%;
    max-width: var(--ha-content-wide-width);
  }

  .options option-card {
    flex: 1;
    min-width: 0;
  }

  @media ${veryNarrowWindow} {
    .options {
      flex-direction: column;
    }
  }
`;
