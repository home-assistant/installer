import { html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";

/**
 * An icon from icons.ts as inline SVG, for markup whose CSS sizes and colors
 * an `svg`, like a settings row's. A button's slot takes `ha-svg-icon`
 * instead, which sizes itself. The text beside an icon says what it says, so
 * it is hidden from assistive technology.
 */
export function renderIcon(path: string, className?: string) {
  return html`<svg
    class=${ifDefined(className)}
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path d=${path} />
  </svg>`;
}
