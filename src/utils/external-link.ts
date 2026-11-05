import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { localize } from "../localization/localize.js";
import {
  EXTERNAL_LINK_HINT_STYLE,
  EXTERNAL_LINK_REL,
  EXTERNAL_LINK_TARGET,
  openExternalLink,
} from "./external-url.js";

export interface ExternalLinkOptions {
  /** The anchor's class, for a view's own styling of it */
  className?: string;
  /**
   * Whether a screen reader is told that the link opens in the browser. Turn
   * it off where the sentence around the link already says so.
   */
  hint?: boolean;
}

/**
 * A link to a page outside the installer. It opens in the browser through
 * the opener, falls back to target and rel when that doesn't run, and says
 * that it leaves the app. Text links take their look from linkStyles, which
 * the shadow root that renders them includes.
 */
export function renderExternalLink(
  url: string,
  content: string | TemplateResult,
  { className, hint = true }: ExternalLinkOptions = {}
) {
  return html`<a
    class=${ifDefined(className)}
    href=${url}
    target=${EXTERNAL_LINK_TARGET}
    rel=${EXTERNAL_LINK_REL}
    @click=${openExternalLink}
    >${content}${hint
      ? html`<span style=${EXTERNAL_LINK_HINT_STYLE}
          >${` ${localize("common.opens_in_browser")}`}</span
        >`
      : nothing}</a
  >`;
}
