import { css, html } from "lit";
import { localize } from "../localization/localize.js";
import { lowWindow } from "./breakpoints.js";
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
    padding: 1rem var(--ha-page-gutter);
  }

  /* Back points the way the page reads */
  .header [slot="start"]:dir(rtl) {
    transform: scaleX(-1);
  }

  /* A low window leaves more of its height to the screen below. Zooming in
     lowers it too: the smallest window, 750px high, is 375px at 200%. Back
     keeps its size: in the install flow, the name of the current step beside
     it may need that height for two lines. */
  @media ${lowWindow} {
    .header {
      padding-block: 0.5rem;
    }
  }
`;

/**
 * A screen before the install flow: the header with Back, and below it the
 * content under the page's title and a line saying what the screen is for.
 * Like the welcome screen before them, these screens center what they show,
 * so a short list doesn't hang at the top of a tall window.
 */
export const pageStyles = css`
  ${pageHeaderStyles}

  :host {
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    height: 100%;
  }

  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    overflow-y: auto;
    padding: 1rem var(--ha-page-gutter) 2rem;
  }

  /* The auto margins center the content while it fits; once it doesn't, it
     scrolls from the top instead of being cut off */
  .content > :first-child {
    margin-top: auto;
  }

  .content > :last-child {
    margin-bottom: auto;
  }

  h1 {
    font-size: 1.75rem;
    font-weight: 400;
    color: var(--ha-text-color);
    margin: 0;
    text-align: center;
  }

  .subtitle {
    font-size: 1rem;
    color: var(--ha-secondary-text-color);
    margin: 0.5rem 0 2rem;
    text-align: center;
    max-width: var(--ha-content-width);
  }
`;

/** The header of a screen that has only Back in it. */
export function renderBackHeader(onBack: (event: MouseEvent) => void) {
  return html`
    <div class="header">
      <wa-button appearance="plain" @click=${onBack}>
        <span slot="start" aria-hidden="true">←</span>
        ${localize("common.back")}
      </wa-button>
    </div>
  `;
}
