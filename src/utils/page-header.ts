import { css, html } from "lit";
import { localize } from "../localization/localize.js";
import "@home-assistant/webawesome/dist/components/button/button.js";

/**
 * The bar at the top of a screen: Back before the install flow, the steps
 * in it. Its sides are the page gutter, like the content and footer below it.
 */
export const pageHeaderStyles = css`
  .header {
    display: flex;
    align-items: center;
    padding: 1rem var(--ha-page-gutter, 2rem);
  }

  /* Back points the way the page reads */
  .header [slot="start"]:dir(rtl) {
    transform: scaleX(-1);
  }
`;

/** The header of a screen that has only Back in it. */
export function renderBackHeader(onBack: (event: MouseEvent) => void) {
  return html`
    <div class="header">
      <wa-button appearance="plain" @click=${onBack}>
        <span slot="start">←</span> ${localize("common.back")}
      </wa-button>
    </div>
  `;
}
