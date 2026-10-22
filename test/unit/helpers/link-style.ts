import { expect } from "@open-wc/testing";

/**
 * Expect the shared link style: underlined, so colour is not the only cue,
 * and in the theme's colour rather than the browser's link blue. The unit
 * test pages don't load styles.css, so that is --ha-primary-color's fallback.
 */
export function expectThemeLink(link: Element) {
  const style = getComputedStyle(link);
  expect(style.textDecorationLine).to.equal("underline");
  expect(style.color).to.equal("rgb(0, 103, 135)");
}
