import { unsafeCSS } from "lit";

/*
 * Where a layout changes with the room it has, as the conditions of `@media`
 * and `@container` rules: `@media ${narrowWindow} { … }`. A custom property
 * can't be used in a condition. Zooming in shrinks the window as CSS sees it:
 * the smallest window, 800×750, is 400×375 at 200%.
 */

/**
 * A narrow window: the page gutter gets thinner, and the step indicator and
 * the welcome footer close up. src/styles.css repeats it for the gutter.
 */
export const narrowWindow = unsafeCSS("(max-width: 600px)");

/**
 * Too narrow for choices side by side, or for a drive card's full padding
 * and icon
 */
export const veryNarrowWindow = unsafeCSS("(max-width: 500px)");

/** A low window: the header and footer get thinner */
export const lowWindow = unsafeCSS("(max-height: 600px)");

/** Too low for all of the welcome screen, which scrolls instead */
export const tooLowForWelcome = unsafeCSS("(max-height: 700px)");

/**
 * For `@container`, on the install progress and success screens: wide
 * enough for Casita beside the details, instead of above them
 */
export const roomForMascotBeside = unsafeCSS("(min-width: 640px)");

/**
 * For `@container`, on the install progress: too narrow for the thinking
 * cloud beside Casita
 */
export const noRoomForCloudBeside = unsafeCSS("(max-width: 520px)");
