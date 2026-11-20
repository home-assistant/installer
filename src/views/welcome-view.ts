import { localize } from "../localization/localize.js";
import { LitElement, html, css, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../utils/view-accessibility.js";
import { logFrontendError } from "../utils/diagnostics.js";
import { narrowWindow } from "../utils/breakpoints.js";
import { customElement, state } from "lit/decorators.js";
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
import {
  homeAssistantLogo,
  mdiOpenInNew,
  mdiTranslate,
} from "../utils/icons.js";
import {
  HomeAssistantScan,
  type FoundHomeAssistant,
} from "../utils/home-assistant-scan.js";
import { sectionLabelStyles } from "../utils/section-label-styles.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import type WaSelect from "@home-assistant/webawesome/dist/components/select/select.js";
import "@home-assistant/webawesome/dist/components/select/select.js";
import "@home-assistant/webawesome/dist/components/option/option.js";
import "../components/ha-svg-icon.js";
import "../components/diagnostics-actions.js";
import "../components/update-banner.js";
import "../components/scroll-row.js";
import { installerUpdate } from "../state/installer-update.js";

// Each language in its own words, like Deutsch, capitalized as in a menu
function languageName(tag: string): string {
  const name =
    new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag;
  return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
}

/** Where a URL opens, as a card names it: its host, with any port */
function hostOf(url: string, address: string): string {
  try {
    return new URL(url).host;
  } catch {
    return address;
  }
}

@customElement("welcome-view")
export class WelcomeView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);

  /** The Home Assistants already on the network, to open instead */
  private readonly _scan = new HomeAssistantScan(this);

  @state()
  private _logoClickCount = 0;

  private _clickResetTimer?: number;

  /** No flow starts while the update installs, which may exit the app */
  @state()
  private _updating = installerUpdate.applying;

  private _unsubscribeUpdate?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._updating = installerUpdate.applying;
    this._unsubscribeUpdate = installerUpdate.subscribe(() => {
      this._updating = installerUpdate.applying;
    });
  }

  static styles = [
    reducedMotionStyles,
    sectionLabelStyles,
    css`
      /* The content centers in the space above the footer, and the footer
         sits at the bottom. A window too low for all of it scrolls, footer
         last. The footer is the page's own, so it stays out of the main
         landmark. */
      :host {
        display: flex;
        flex-direction: column;
        align-items: center;
        box-sizing: border-box;
        height: 100%;
        min-height: 0;
        overflow-y: auto;
        padding: 2rem var(--ha-page-gutter) 1rem;
        text-align: center;
      }

      :host > * {
        flex-shrink: 0;
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
      }

      .language {
        width: 12rem;
        text-align: start;
      }

      /* The translate icon and the names say what it is */
      .language::part(form-control-label) {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }

      /* The logo, intro and Let's go center in the space above the footer.
         What is found on the network goes in the half below them, so they
         only move up when it needs more room than that half has. */
      main {
        flex: 1 0 auto;
        align-self: stretch;
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      main::before {
        content: "";
      }

      main::before,
      .below {
        flex: 1 1 0;
      }

      .start,
      .below {
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      .below {
        align-self: stretch;
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

      @keyframes appear {
        from {
          opacity: 0;
        }
      }

      .found {
        width: 100%;
        margin-top: 1.5rem;
        animation: appear 0.3s ease-out;
      }

      /* The row keeps room above its cards for their focus ring */
      .found .section-label {
        margin-bottom: 0.25rem;
      }

      /* One row, which scrolls when it doesn't fit */
      .found ul {
        list-style: none;
        margin-block: 0;
        padding: 0;
        display: flex;
        gap: 0.75rem;
      }

      .found li {
        display: flex;
        width: 14.5rem;
        scroll-snap-align: start;
      }

      /* A card that opens the Home Assistant in the browser */
      .instance {
        flex: 1;
        min-width: 0;
        box-sizing: border-box;
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        padding: 0.75rem 1rem;
        background-color: var(--ha-card-background);
        border: 2px solid var(--ha-border-color);
        border-radius: var(--ha-card-border-radius);
        color: var(--ha-text-color);
        text-align: start;
        text-decoration: none;
        transition:
          border-color 0.2s ease,
          box-shadow 0.2s ease;
      }

      .instance:hover {
        border-color: var(--ha-primary-color);
        box-shadow: var(--ha-card-hover-shadow);
      }

      .instance:focus-visible {
        outline: var(--wa-focus-ring);
        outline-offset: var(--wa-focus-ring-offset);
      }

      .instance-logo {
        flex-shrink: 0;
        --mdc-icon-size: 28px;
        color: var(--ha-primary-color);
      }

      .instance-text {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.125rem;
      }

      /* A long name takes two lines; the rest shows when pointed at */
      .instance-name {
        max-width: 100%;
        font-weight: 500;
        overflow-wrap: anywhere;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
      }

      .instance-address {
        font-size: 0.8125rem;
        color: var(--ha-secondary-text-color);
      }

      .instance-state {
        margin-top: 0.125rem;
        padding: 0 0.5rem;
        border: 1px solid currentColor;
        border-radius: 999px;
        font-size: 0.75rem;
        font-weight: 500;
        line-height: 1.5;
        color: var(--ha-secondary-text-color);
      }

      .instance-state.not-onboarded {
        color: var(--ha-primary-color);
      }

      .instance-open {
        flex-shrink: 0;
        --mdc-icon-size: 16px;
        color: var(--ha-secondary-text-color);
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
      ${this._renderLanguages()}
      <update-banner></update-banner>
      <main>
        <div class="start">
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
            pill
            variant="brand"
            appearance="accent"
            size="l"
            ?disabled=${this._updating}
            @click=${this._onLetsGo}
          >
            ${localize("views.welcome_view.let_s_go")}
            <span slot="end" aria-hidden="true">→</span>
          </wa-button>
        </div>
        <div class="below">${this._renderFound()}</div>
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

  // Nothing until a Home Assistant answers
  private _renderFound() {
    const found = this._scan.found;
    if (found.length === 0) return nothing;
    return html`<section class="found" aria-labelledby="found-title">
      <h2 class="section-label" id="found-title">
        ${localize("views.welcome_view.found_title")}
      </h2>
      <scroll-row>
        <ul>
          ${repeat(
            found,
            // Each keeps its card, and with it the focus, as others come
            // and go before it
            ({ address }) => address,
            (instance) => html`<li>${this._renderInstance(instance)}</li>`
          )}
        </ul>
      </scroll-row>
    </section>`;
  }

  // Each opens in the browser, where one still to be onboarded starts that
  private _renderInstance({ address, url, name, state }: FoundHomeAssistant) {
    const shownName = name || localize("views.welcome_view.unnamed_instance");
    return renderExternalLink(
      url,
      html`<ha-svg-icon
          class="instance-logo"
          .path=${homeAssistantLogo}
          .viewBox=${"0 0 240 240"}
        ></ha-svg-icon>
        <span class="instance-text">
          <span class="instance-name" title=${shownName}
            ><bdi>${shownName}</bdi></span
          >
          <span class="instance-address"
            ><bdi dir="ltr">${hostOf(url, address)}</bdi></span
          >
          ${this._renderState(state)}
        </span>
        <ha-svg-icon
          class="instance-open"
          .path=${mdiOpenInNew}
        ></ha-svg-icon>`,
      { className: "instance" }
    );
  }

  private _renderState(state: FoundHomeAssistant["state"]) {
    switch (state) {
      case "installing":
        return html`<span class="instance-state installing"
          >${localize("views.welcome_view.state_installing")}</span
        >`;
      case "not_onboarded":
        return html`<span class="instance-state not-onboarded"
          >${localize("views.welcome_view.state_not_onboarded")}</span
        >`;
      default:
        return nothing;
    }
  }

  // Hidden while English is the only language
  private _renderLanguages() {
    const languages = shippedLanguages();
    if (languages.length < 2) return nothing;
    return html`<header>
      <wa-select
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
      </wa-select>
    </header>`;
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
