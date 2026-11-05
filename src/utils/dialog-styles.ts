import { css } from "lit";

/**
 * What every wa-dialog shares. Each shadow root that renders one needs this
 * sheet: styles.css does not reach into shadow roots.
 */
export const dialogStyles = css`
  /* One width for a dialog that asks something, and a wider one for a
     dialog that holds a log. */
  wa-dialog {
    --width: 32rem;
  }
  wa-dialog.wide {
    --width: 36rem;
  }

  /* Web Awesome scales a dialog in and out even when the user asked for
     less motion, so then it appears and goes at once. */
  @media (prefers-reduced-motion: reduce) {
    wa-dialog::part(dialog) {
      animation: none !important;
    }
  }
`;
