import { localize } from "../localization/localize.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../utils/view-accessibility.js";
import { logFrontendError } from "../utils/diagnostics.js";
import { customElement, state } from "lit/decorators.js";
import { openExternalLink } from "../utils/external-url.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "../components/casita-mascot.js";

@customElement("welcome-view")
export class WelcomeView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  @state()
  private _logoClickCount = 0;

  private _clickResetTimer?: number;

  static styles = css`
    ${reducedMotionStyles}
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 2rem;
      text-align: center;
      position: relative;
    }

    @media (max-height: 700px) {
      :host {
        box-sizing: border-box;
        min-height: 0;
        overflow-y: auto;
        justify-content: flex-start;
        padding-bottom: 6rem;
      }

      :host > * {
        flex-shrink: 0;
      }
    }

    casita-mascot {
      width: 96px;
      height: 96px;
      margin-bottom: 1.5rem;
    }

    @keyframes soft-pulse {
      0%,
      100% {
        transform: scale(1);
        filter: drop-shadow(0 0 0 rgba(24, 188, 242, 0));
      }
      50% {
        transform: scale(1.02);
        filter: drop-shadow(0 0 15px rgba(24, 188, 242, 0.3));
      }
    }

    .logo-container {
      margin: 0 0 2rem;
      font-size: inherit;
      line-height: 1;
    }

    .logo {
      width: 500px;
      max-width: 100%;
      height: auto;
    }

    .logo-container:hover .logo {
      animation: soft-pulse 3s ease-in-out infinite;
    }

    .logo-dark {
      display: none;
    }

    @media (prefers-color-scheme: dark) {
      .logo-light {
        display: none;
      }
      .logo-dark {
        display: block;
      }
    }

    .welcome-text {
      max-width: 520px;
      color: var(--ha-secondary-text-color, #727272);
      line-height: 1.6;
      margin-bottom: 2rem;
    }

    .welcome-text p {
      margin: 0 0 1rem 0;
    }

    .welcome-text p:last-child {
      margin-bottom: 0;
    }

    .learn-more {
      margin-top: 1rem;
      font-size: 0.875rem;
      color: var(--ha-secondary-text-color, #9e9e9e);
      text-decoration: underline;
    }

    .ohf-link {
      position: absolute;
      bottom: 2rem;
      text-decoration: none;
    }

    @media (max-height: 700px) {
      .ohf-link {
        position: static;
        margin-top: 2rem;
      }
    }

    .ohf-logo {
      width: 180px;
      opacity: 0.7;
      transition: opacity 0.2s ease;
    }

    .ohf-link:hover .ohf-logo {
      opacity: 1;
    }

    .ohf-logo-dark {
      display: none;
    }

    @media (prefers-color-scheme: dark) {
      .ohf-logo-light {
        display: none;
      }
      .ohf-logo-dark {
        display: block;
      }
    }
  `;

  render() {
    return html`
      <h1 class="logo-container" @click=${this._onLogoClick}>
        <img
          class="logo logo-light"
          src="/assets/home-assistant-logo-light.svg"
          alt=${localize("brand.home_assistant")}
        />
        <img
          class="logo logo-dark"
          src="/assets/home-assistant-logo-dark.svg"
          alt=${localize("brand.home_assistant")}
        />
      </h1>

      <casita-mascot mood="winking"></casita-mascot>

      <div class="welcome-text">
        <p>
          ${localize(
            "views.welcome_view.welcome_to_home_assistant_a_local_and_privacy_first_home_automation_platfor"
          )}
        </p>
        <p>
          ${localize(
            "views.welcome_view.this_installer_guides_you_through_setting_up_home_assistant_on_your_hardwar"
          )}
        </p>
      </div>

      <wa-button
        variant="brand"
        appearance="accent"
        size="l"
        @click=${this._onLetsGo}
      >
        ${localize("views.welcome_view.let_s_go")} <span slot="end">→</span>
      </wa-button>

      <a
        class="learn-more"
        href="https://www.home-assistant.io/installation/"
        target="_blank"
        rel="noopener noreferrer"
        @click=${(event: Event) =>
          openExternalLink(
            event,
            "https://www.home-assistant.io/installation/"
          )}
      >
        ${localize(
          "views.welcome_view.learn_more_about_installing_home_assistant"
        )}
      </a>

      <a
        class="ohf-link"
        href="https://www.openhomefoundation.org/"
        target="_blank"
        rel="noopener noreferrer"
        @click=${(event: Event) =>
          openExternalLink(event, "https://www.openhomefoundation.org/")}
      >
        <img
          class="ohf-logo ohf-logo-light"
          src="/assets/ohf-logo-light.svg"
          alt=${localize("views.welcome_view.open_home_foundation")}
        />
        <img
          class="ohf-logo ohf-logo-dark"
          src="/assets/ohf-logo-dark.svg"
          alt=${localize("views.welcome_view.open_home_foundation")}
        />
      </a>
    `;
  }

  private _onLogoClick() {
    this._logoClickCount++;

    // Reset the counter after 2 seconds of no clicks
    if (this._clickResetTimer) {
      clearTimeout(this._clickResetTimer);
    }
    this._clickResetTimer = window.setTimeout(() => {
      this._logoClickCount = 0;
    }, 2000);

    // Play sound after 5 clicks
    if (this._logoClickCount === 5) {
      this._playEasterEgg();
      this._logoClickCount = 0;
    }
  }

  private _playEasterEgg() {
    const audio = new Audio("/assets/audio/home-assistant.wav");
    audio.play().catch((error) => {
      logFrontendError(error);
    });
  }

  private _onLetsGo() {
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { view: "path-selection" },
        bubbles: true,
        composed: true,
      })
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._clickResetTimer) {
      clearTimeout(this._clickResetTimer);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "welcome-view": WelcomeView;
  }
}
