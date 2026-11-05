import { css } from "lit";
import { panelStyles } from "../../utils/panel-styles.js";
import { stepStyles } from "../../utils/step-styles.js";
import { reducedMotionStyles } from "../../utils/view-accessibility.js";

/** Layout shared by the live USB screens: a step, with its form or summary in a panel. */
export const liveUsbStyles = [
  reducedMotionStyles,
  stepStyles,
  css`
    .card {
      ${panelStyles}
    }
  `,
];
