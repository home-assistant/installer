import { css } from "lit";

/**
 * Links in text. The underline sets them apart from the words around them,
 * as their colour alone is too close to the text's. Every shadow root that
 * renders an <a>, such as renderErrorHelp()'s, needs this sheet: styles.css
 * does not reach into shadow roots.
 */
export const linkStyles = css`
  a {
    color: var(--ha-primary-color);
    text-decoration: underline;
  }
`;
