import { css } from "lit";

/**
 * The dot that shows how far along a step is, as a `.status-dot` that is
 * `.completed` or `.active`. Each state has its own shape, not only its own
 * color: upcoming is an empty ring, completed a filled dot, current a filled
 * dot in a ring. The step indicator and the install's stage list share it, so
 * the two lists keep reading alike. A list that wants smaller dots sets their
 * width and height after this sheet.
 */
export const statusDotStyles = css`
  .status-dot {
    box-sizing: border-box;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid var(--ha-inactive-color, #8c8c8c);
  }

  .status-dot.active,
  .status-dot.completed {
    border-color: var(--ha-primary-color, #03a9f4);
    background-color: var(--ha-primary-color, #03a9f4);
  }

  .status-dot.active {
    outline: 2px solid var(--ha-primary-color, #03a9f4);
    outline-offset: 2px;
  }

  /* Forced colors would paint the fills like the page, leaving the
     completed dots as empty as the upcoming ones */
  @media (forced-colors: active) {
    .status-dot {
      border-color: GrayText;
    }

    .status-dot.completed {
      border-color: CanvasText;
      background-color: CanvasText;
    }

    .status-dot.active {
      border-color: Highlight;
      background-color: Highlight;
      outline-color: Highlight;
    }
  }
`;
