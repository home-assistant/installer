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

  /* Back points the way the page reads */
  .header [slot="start"]:dir(rtl) {
    transform: scaleX(-1);
  }

  /* A low window leaves more of its height to the screen below. Zooming in
     lowers it too: the smallest window, 750px high, is 375px at 200%. The
     text keeps its size; only the space around it shrinks. */
  @media (max-height: 600px) {
    .header {
      padding-block: 0.5rem;
    }

    .header wa-button {
      --wa-form-control-height: 2.25em;
    }
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
