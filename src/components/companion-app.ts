import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import "@home-assistant/webawesome/dist/components/qr-code/qr-code.js";
import { localize } from "../localization/localize.js";
import { renderExternalLink } from "../utils/external-link.js";
import { mdiApple, mdiGooglePlay } from "../utils/icons.js";
import { panelStyles } from "../utils/panel-styles.js";
import { renderIcon } from "../utils/render-icon.js";
import {
  APP_STORE_URL,
  COMPANION_APP_URL,
  GOOGLE_PLAY_URL,
} from "../utils/urls.js";

/**
 * Where to get the companion app: a code for the phone it goes on, which
 * opens that phone's store, and a link to each store for this computer.
 * Shown while Home Assistant installs, when there is time to get it, and
 * once it is ready.
 */
@customElement("companion-app")
export class CompanionApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 100%;
      max-width: var(--ha-content-width);
      text-align: start;
    }

    /* Its heading as close to the code as the next steps' heading is to
       the steps */
    .panel {
      ${panelStyles}
      gap: 1rem;
    }

    h3 {
      font-size: 1rem;
      font-weight: 500;
      color: var(--ha-text-color);
      margin: 0;
    }

    .get {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 1rem 1.5rem;
    }

    /* Dark on white in either theme, with the quiet zone a scanner needs */
    wa-qr-code {
      flex-shrink: 0;
      padding: 0.5rem;
      border-radius: var(--ha-small-border-radius);
      background-color: #fff;
      color: #000;
    }

    .stores {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      flex: 1 1 12rem;
      min-width: 0;
    }

    .scan {
      margin: 0;
      font-size: 0.875rem;
      line-height: 1.5;
      color: var(--ha-secondary-text-color);
    }

    .app-links {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .app-link {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.625rem 1rem;
      background-color: var(--ha-background-color);
      border: 1px solid var(--ha-control-border-color);
      border-radius: var(--ha-small-border-radius);
      color: var(--ha-text-color);
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 500;
      transition: all 0.2s ease;
    }

    .app-link:hover {
      background-color: var(--ha-primary-fill);
      border-color: var(--ha-primary-color);
      color: var(--wa-color-brand-on-loud);
    }

    .app-link:focus-visible {
      outline: var(--wa-focus-ring);
      outline-offset: var(--wa-focus-ring-offset);
    }

    .app-link:hover svg {
      fill: var(--wa-color-brand-on-loud);
    }

    .app-link svg {
      width: 20px;
      height: 20px;
      fill: var(--ha-text-color);
      transition: fill 0.2s ease;
    }

    @media (prefers-reduced-motion: reduce) {
      .app-link,
      .app-link svg {
        transition: none;
      }
    }

    @media (forced-colors: active) {
      wa-qr-code {
        forced-color-adjust: none;
      }
    }
  `;

  render() {
    return html`
      <div class="panel">
        <h3>${localize("components.companion_app.title")}</h3>
        <div class="get">
          <wa-qr-code
            value=${COMPANION_APP_URL}
            label=${localize("components.companion_app.qr_label")}
            size="104"
            error-correction="M"
          ></wa-qr-code>
          <div class="stores">
            <p class="scan">${localize("components.companion_app.scan")}</p>
            <div class="app-links">
              ${renderExternalLink(
                APP_STORE_URL,
                html`${renderIcon(mdiApple)}
                  <span
                    >${localize("components.companion_app.app_store")}</span
                  >`,
                { className: "app-link" }
              )}
              ${renderExternalLink(
                GOOGLE_PLAY_URL,
                html`${renderIcon(mdiGooglePlay)}
                  <span
                    >${localize("components.companion_app.google_play")}</span
                  >`,
                { className: "app-link" }
              )}
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "companion-app": CompanionApp;
  }
}
