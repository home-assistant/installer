import { expect } from "@open-wc/testing";

/**
 * Expect the shared link style: underlined, so colour is not the only cue,
 * and in the theme's colour rather than the browser's link blue: the light
 * theme's --ha-primary-color, which every unit test page loads.
 */
export function expectThemeLink(link: Element) {
  const style = getComputedStyle(link);
  expect(style.textDecorationLine).to.equal("underline");
  expect(style.color).to.equal("rgb(0, 103, 135)");
}
