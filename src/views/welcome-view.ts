import { localize } from "../localization/localize.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../utils/view-accessibility.js";
import { logFrontendError } from "../utils/diagnostics.js";
import { narrowWindow, tooLowForWelcome } from "../utils/breakpoints.js";
import { customElement, state } from "lit/decorators.js";
import { renderExternalLink } from "../utils/external-link.js";
import {
  INSTALLATION_GUIDE_URL,
  OPEN_HOME_FOUNDATION_URL,
} from "../utils/urls.js";
import { fireEvent } from "../utils/fire-event.js";
import { THEME_CHANGE, darkTheme } from "../utils/theme.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "../components/accessibility-menu.js";
import "../components/language-menu.js";
import "../components/diagnostics-actions.js";
import "../components/update-banner.js";
import { installerUpdate } from "../state/installer-update.js";

@customElement("welcome-view")
export class WelcomeView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  @state()
  private _logoClickCount = 0;

  private _clickResetTimer?: number;

  /** No flow starts while the update installs, which may exit the app */
  @state()
  private _updating = installerUpdate.applying;

  private _unsubscribeUpdate?: () => void;

  // The logos come as artwork for each theme
  private readonly _onThemeChanged = () => this.requestUpdate();

  connectedCallback() {
    super.connectedCallback();
    this._updating = installerUpdate.applying;
    this._unsubscribeUpdate = installerUpdate.subscribe(() => {
      this._updating = installerUpdate.applying;
    });
    window.addEventListener(THEME_CHANGE, this._onThemeChanged);
  }

  static styles = [
    reducedMotionStyles,
    css`
      /* The content centers in the space above the footer, and the footer
         sits at the bottom. A window too low for both scrolls, footer last.
         The footer is the page's own, so it stays out of the main landmark.
         The header lines up with the next screens', so Accessibility stays
         in its place. */
      :host {
        display: flex;
        flex-direction: column;
        align-items: center;
        box-sizing: border-box;
        height: 100%;
        padding: 1rem var(--ha-page-gutter);
        text-align: center;
      }

      @media ${tooLowForWelcome} {
        :host {
          min-height: 0;
          overflow-y: auto;
        }

        :host > * {
          flex-shrink: 0;
        }
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

      /* At the end of the first line, where a page offers its languages */
      header {
        align-self: flex-end;
        display: flex;
        gap: 0.25rem;
      }

      main {
        flex: 1 0 auto;
        align-self: stretch;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
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

      .intro {
        max-width: var(--ha-content-width);
        color: var(--ha-secondary-text-color);
        line-height: 1.6;
        margin: 0 0 3rem;
      }

      /* The arrow points the way the page reads */
      wa-button [slot="end"]:dir(rtl) {
        transform: scaleX(-1);
      }

      /* Report a problem, the foundation logo and Learn more, with the logo
         in the middle however wide the two sides are */
      .welcome-footer {
        align-self: stretch;
        padding-top: 2rem;
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 1rem;
        font-size: 0.875rem;
        color: var(--ha-secondary-text-color);
      }

      .report {
        justify-self: start;
        --diagnostics-link-color: var(--ha-secondary-text-color);
      }

      .learn-more {
        justify-self: end;
        color: inherit;
        text-decoration: underline;
      }

      /* Too narrow for three columns: stack them around the logo */
      @media ${narrowWindow} {
        .welcome-footer {
          grid-template-columns: auto;
          justify-items: center;
          gap: 0.5rem;
        }

        .report,
        .learn-more {
          justify-self: center;
        }

        .ohf-link {
          order: -1;
        }
      }

      .ohf-link {
        display: block;
        line-height: 0;
        text-decoration: none;
      }

      /* Quiet until pointed at: the footer should not compete with Let's go */
      .ohf-logo {
        width: 140px;
        filter: grayscale(1);
        opacity: 0.6;
        transition:
          opacity 0.2s ease,
          filter 0.2s ease;
      }

      .ohf-link:hover .ohf-logo,
      .ohf-link:focus-visible .ohf-logo {
        filter: none;
        opacity: 1;
      }
    `,
  ];

  // The logo's easter egg is hidden on purpose, so it needs no keyboard way in
  /* eslint-disable lit-a11y/click-events-have-key-events */
  render() {
    const theme = darkTheme() ? "dark" : "light";
    return html`
      <header>
        <language-menu></language-menu>
        <accessibility-menu></accessibility-menu>
      </header>
      <update-banner></update-banner>
      <main>
        <h1 class="logo-container" @click=${this._onLogoClick}>
          <img
            class="logo"
            src="/assets/home-assistant-logo-${theme}.svg"
            alt=${localize("views.welcome_view.home_assistant")}
          />
        </h1>

        <p class="intro">${localize("views.welcome_view.subtitle")}</p>

        <wa-button
          variant="brand"
          appearance="accent"
          size="l"
          ?disabled=${this._updating}
          @click=${this._onLetsGo}
        >
          ${localize("views.welcome_view.let_s_go")}
          <span slot="end" aria-hidden="true">→</span>
        </wa-button>
      </main>

      <footer class="welcome-footer">
        <diagnostics-actions class="report"></diagnostics-actions>
        ${renderExternalLink(
          OPEN_HOME_FOUNDATION_URL,
          html`<img
            class="ohf-logo"
            src="/assets/ohf-logo-${theme}.svg"
            alt=${localize("views.welcome_view.open_home_foundation")}
          />`,
          { className: "ohf-link" }
        )}
        ${renderExternalLink(
          INSTALLATION_GUIDE_URL,
          localize("views.welcome_view.learn_more"),
          { className: "learn-more" }
        )}
      </footer>
    `;
  }
  /* eslint-enable lit-a11y/click-events-have-key-events */

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
      void this._playEasterEgg();
      this._logoClickCount = 0;
    }
  }

  // WebKitGTK can't play media from tauri:// URLs, so decode it with Web Audio
  private async _playEasterEgg() {
    const context = new AudioContext();
    try {
      const response = await fetch("/assets/audio/home-assistant.mp3");
      const source = context.createBufferSource();
      source.buffer = await context.decodeAudioData(
        await response.arrayBuffer()
      );
      source.connect(context.destination);
      source.onended = () => void context.close();
      source.start();
    } catch (error) {
      void context.close();
      logFrontendError(error);
    }
  }

  private _onLetsGo() {
    fireEvent(this, "navigate", { view: "path-selection" });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener(THEME_CHANGE, this._onThemeChanged);
    this._unsubscribeUpdate?.();
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
