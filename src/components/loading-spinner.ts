import type { CSSResultGroup } from "lit";
import { customElement } from "lit/decorators.js";
import WaSpinner from "@home-assistant/webawesome/dist/components/spinner/spinner.js";
import { reducedMotionStyles } from "../utils/view-accessibility.js";

/**
 * `<wa-spinner>` that holds still with reduced motion.
 *
 * Only its `<svg>` is a part, not the arc that sweeps around it, so the
 * reduced-motion sheet has to be in its own shadow root. The arc it stops
 * on still reads as busy.
 */
@customElement("loading-spinner")
export class LoadingSpinner extends WaSpinner {
  static get styles(): CSSResultGroup {
    return [super.styles, reducedMotionStyles];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "loading-spinner": LoadingSpinner;
  }
}
