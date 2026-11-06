import { getLanguage, localize } from "../localization/localize.js";
import { LitElement, html, css, nothing } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../utils/view-accessibility.js";
import { logFrontendError } from "../utils/diagnostics.js";
import { narrowWindow, tooLowForWelcome } from "../utils/breakpoints.js";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { renderExternalLink } from "../utils/external-link.js";
import {
  INSTALLATION_GUIDE_URL,
  OPEN_HOME_FOUNDATION_URL,
} from "../utils/urls.js";
import { fireEvent } from "../utils/fire-event.js";
import {
  chooseLanguage,
  shippedLanguages,
  shownLanguage,
} from "../localization/initialize.js";
import { mdiFormatSize, mdiTranslate } from "../utils/icons.js";
import {
  TEXT_SIZES,
  TEXT_SIZE_CHANGE,
  setTextSize,
  textSize,
} from "../utils/text-size.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import type WaSelect from "@home-assistant/webawesome/dist/components/select/select.js";
import "@home-assistant/webawesome/dist/components/select/select.js";
import "@home-assistant/webawesome/dist/components/option/option.js";
import "../components/ha-svg-icon.js";
import "../components/diagnostics-actions.js";
import "../components/update-banner.js";
import { installerUpdate } from "../state/installer-update.js";

// Each language in its own words, like Deutsch, capitalized as in a menu
function languageName(tag: string): string {
  const name =
    new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag;
  return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
}

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

  // Ctrl or Cmd with + and − change the size too
  private readonly _onTextSizeChanged = () => this.requestUpdate();

  connectedCallback() {
    super.connectedCallback();
    this._updating = installerUpdate.applying;
    this._unsubscribeUpdate = installerUpdate.subscribe(() => {
      this._updating = installerUpdate.applying;
    });
    window.addEventListener(TEXT_SIZE_CHANGE, this._onTextSizeChanged);
  }

  static styles = [
    reducedMotionStyles,
    css`
      /* The content centers in the space above the footer, and the footer
         sits at the bottom. A window too low for both scrolls, footer last.
         The footer is the page's own, so it stays out of the main landmark. */
      :host {
        display: flex;
        flex-direction: column;
        align-items: center;
        box-sizing: border-box;
        height: 100%;
        padding: 2rem var(--ha-page-gutter) 1rem;
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
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 0.5rem;
      }

      header wa-select {
        text-align: start;
      }

      .text-size {
        width: 9rem;
      }

      .language {
        width: 12rem;
      }

      /* The icons and the values say what each one is */
      header wa-select::part(form-control-label) {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
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

      /* Both logos come as artwork for each theme */
      .logo-dark,
      .ohf-logo-dark {
        display: none;
      }

      @media (prefers-color-scheme: dark) {
        .logo-light,
        .ohf-logo-light {
          display: none;
        }
        .logo-dark,
        .ohf-logo-dark {
          display: block;
        }
      }
    `,
  ];

  // The logo's easter egg is hidden on purpose, so it needs no keyboard way in
  /* eslint-disable lit-a11y/click-events-have-key-events */
  render() {
    return html`
      <header>${this._renderTextSize()} ${this._renderLanguages()}</header>
      <update-banner></update-banner>
      <main>
        <h1 class="logo-container" @click=${this._onLogoClick}>
          <img
            class="logo logo-light"
            src="/assets/home-assistant-logo-light.svg"
            alt=${localize("views.welcome_view.home_assistant")}
          />
          <img
            class="logo logo-dark"
            src="/assets/home-assistant-logo-dark.svg"
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
              class="ohf-logo ohf-logo-light"
              src="/assets/ohf-logo-light.svg"
              alt=${localize("views.welcome_view.open_home_foundation")}
            />
            <img
              class="ohf-logo ohf-logo-dark"
              src="/assets/ohf-logo-dark.svg"
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

  private _renderTextSize() {
    const percent = new Intl.NumberFormat(getLanguage(), { style: "percent" });
    return html`<wa-select
      class="text-size"
      size="s"
      label=${localize("views.welcome_view.text_size")}
      .value=${live(String(textSize()))}
      @change=${this._onTextSizeChange}
    >
      <ha-svg-icon slot="start" .path=${mdiFormatSize}></ha-svg-icon>
      ${TEXT_SIZES.map(
        (size) =>
          html`<wa-option value=${String(size)}
            >${percent.format(size)}</wa-option
          >`
      )}
    </wa-select>`;
  }

  private _onTextSizeChange(event: Event) {
    setTextSize(Number((event.target as WaSelect).value));
  }

  // Hidden while English is the only language
  private _renderLanguages() {
    const languages = shippedLanguages();
    if (languages.length < 2) return nothing;
    return html`<wa-select
      class="language"
      size="s"
      label=${localize("views.welcome_view.language")}
      .value=${shownLanguage()}
      @change=${this._onLanguageChange}
    >
      <ha-svg-icon slot="start" .path=${mdiTranslate}></ha-svg-icon>
      ${languages
        .map((tag) => ({ tag, name: languageName(tag) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
          ({ tag, name }) =>
            html`<wa-option value=${tag} lang=${tag}>${name}</wa-option>`
        )}
    </wa-select>`;
  }

  private _onLanguageChange(event: Event) {
    void chooseLanguage((event.target as WaSelect).value as string);
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
    window.removeEventListener(TEXT_SIZE_CHANGE, this._onTextSizeChanged);
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
