import { css, html } from "lit";
import { localize } from "../localization/localize.js";
import "@home-assistant/webawesome/dist/components/button/button.js";

/**
 * The bar holding Back at the top of a screen. The install flow and the
 * screens before it share it, so Back never moves between them. Its sides
 * are the page gutter, like the content and footer below it.
 */
export const pageHeaderStyles = css`
  .header {
    display: flex;
    align-items: center;
    padding: 1rem var(--ha-page-gutter, 2rem);
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
