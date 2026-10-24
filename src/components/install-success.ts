import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { localize } from "../localization/localize.js";
import { renderExternalLink } from "../utils/external-link.js";
import { linkStyles } from "../utils/link-styles.js";
import { panelStyles } from "../utils/panel-styles.js";
import { roomForMascotBeside } from "../utils/breakpoints.js";
import { sectionLabelStyles } from "../utils/section-label-styles.js";
import { getPlatform } from "../utils/platform.js";
import { mdiApple, mdiGooglePlay } from "../utils/icons.js";
import { APP_STORE_URL, GOOGLE_PLAY_URL } from "../utils/urls.js";
import { renderIcon } from "../utils/render-icon.js";
import { renderCasitaHappy } from "./install-mascot.js";
import "./inline-notice.js";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../utils/view-accessibility.js";

@customElement("install-success")
export class InstallSuccess extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);

  static styles = [
    reducedMotionStyles,
    linkStyles,
    sectionLabelStyles,
    css`
      /* Its own width, not the window's, decides between the layouts */
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        text-align: center;
        container-type: inline-size;
      }

      /* Narrow, Casita stands above the heading and the next steps */
      .layout {
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      .details {
        display: flex;
        flex-direction: column;
        align-items: center;
        width: 100%;
      }

      .mascot-container {
        width: 140px;
        height: 140px;
        margin-bottom: 1.5rem;
      }

      .casita-mascot {
        width: 100%;
        height: 100%;
      }

      h2 {
        font-size: 2rem;
        font-weight: 500;
        color: var(--ha-text-color);
        margin: 0 0 0.5rem 0;
      }

      .subtitle {
        font-size: 1rem;
        color: var(--ha-secondary-text-color);
        margin: 0 0 2rem 0;
      }

      .next-steps {
        width: 100%;
        max-width: var(--ha-content-width);
        text-align: start;
        margin-bottom: 2rem;
      }

      .next-steps-title {
        margin-bottom: 1rem;
      }

      .next-steps inline-notice {
        margin-bottom: 1rem;
      }

      .steps-list {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .step-item {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
      }

      .step-number {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background-color: var(--ha-primary-fill);
        color: var(--wa-color-brand-on-loud);
        font-size: 0.875rem;
        font-weight: 500;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      .step-text {
        font-size: 1rem;
        color: var(--ha-text-color);
        line-height: 1.5;
        padding-top: 2px;
        min-width: 0;
        overflow-wrap: anywhere;
      }

      /* Its heading as close to the links as the next steps' heading is
         to the steps */
      .companion-section {
        ${panelStyles}
        gap: 1rem;
      }

      .companion-title {
        font-size: 1rem;
        font-weight: 500;
        color: var(--ha-text-color);
        margin: 0;
      }

      .app-links {
        display: flex;
        justify-content: center;
        gap: 1rem;
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

      .app-link:hover svg {
        fill: var(--wa-color-brand-on-loud);
      }

      .app-link svg {
        width: 20px;
        height: 20px;
        fill: var(--ha-text-color);
        transition: fill 0.2s ease;
      }

      .tip-section {
        width: 100%;
        box-sizing: border-box;
        max-width: var(--ha-content-width);
        margin-bottom: 2rem;
        padding: 1rem;
        background-color: rgba(3, 169, 244, 0.1);
        border-radius: var(--ha-small-border-radius);
        font-size: 0.875rem;
        color: var(--ha-text-color);
        text-align: start;
      }

      .next-steps-footer {
        margin: 1.25rem 0 0;
      }

      .tip-section strong {
        color: var(--ha-primary-color);
      }

      /* Wide enough, Casita stands beside the next steps, under the heading,
         so the artwork doesn't push them down and out of view */
      @container ${roomForMascotBeside} {
        /* Casita stays level with the top of the next steps, however far
           down they run */
        .layout {
          flex-flow: row wrap;
          justify-content: center;
          align-items: flex-start;
          column-gap: 3rem;
        }

        /* Casita is hidden from assistive technology, so moving the heading
           above it leaves the reading order as it was */
        .heading {
          order: -1;
          flex-basis: 100%;
        }

        /* The other steps' spacing under their subtitle */
        .subtitle {
          margin-bottom: 1.5rem;
        }

        /* No basis, so the details share Casita's line even where they have
           to narrow to fit */
        .details {
          align-items: stretch;
          flex: 1 1 0;
          max-width: var(--ha-content-width);
          min-width: 0;
        }

        .mascot-container {
          flex-shrink: 0;
          margin-bottom: 0;
        }
      }
    `,
  ];
  @property({ attribute: false }) subtitle: string | TemplateResult = "";
  @property({ attribute: false }) steps: (string | TemplateResult)[] = [];
  @property({ attribute: false }) tip: string | TemplateResult = "";
  /** Warns not to format the written drive, where the OS offers to. */
  @property({ attribute: false }) formatWarning = false;
  /** Shown below the steps, such as a link to further documentation. */
  @property({ attribute: false }) footer: string | TemplateResult = "";

  render() {
    const title = localize("components.install_success.title");
    const platform = this.formatWarning && getPlatform();
    const notice =
      platform === "macos"
        ? localize("common.success.do_not_format.macos")
        : platform === "windows"
          ? localize("common.success.do_not_format.windows")
          : "";

    return html`
      <div class="layout">
        <div class="mascot-container" aria-hidden="true">
          ${renderCasitaHappy()}
        </div>
        <div class="heading">
          <h2>${title}</h2>
          <p class="subtitle">${this.subtitle}</p>
        </div>
        <div class="details">
          <div class="next-steps">
            <h3 class="section-label next-steps-title">
              ${localize("components.install_success.next_steps")}
            </h3>
            ${notice
              ? html`<inline-notice><p>${notice}</p></inline-notice>`
              : ""}
            <ol
              class="steps-list"
              role="list"
              aria-label=${localize("components.install_success.next_steps")}
            >
              ${this.steps.map(
                (step, index) => html`
                  <li class="step-item">
                    <span class="step-number">${index + 1}</span>
                    <span class="step-text">${step}</span>
                  </li>
                `
              )}
            </ol>
            ${this.footer
              ? html`<p class="next-steps-footer">${this.footer}</p>`
              : ""}
          </div>
          <slot></slot>
          ${this.tip ? html`<div class="tip-section">${this.tip}</div>` : ""}
          <!-- A heading of its own, so the app links don't read as part of
               the next steps -->
          <div class="companion-section">
            <h3 class="companion-title">
              ${localize("components.install_success.companion_app")}
            </h3>
            <div class="app-links">
              ${renderExternalLink(
                APP_STORE_URL,
                html`${renderIcon(mdiApple)}
                  <span
                    >${localize("components.install_success.app_store")}</span
                  >`,
                { className: "app-link" }
              )}
              ${renderExternalLink(
                GOOGLE_PLAY_URL,
                html`${renderIcon(mdiGooglePlay)}
                  <span
                    >${localize("components.install_success.google_play")}</span
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
    "install-success": InstallSuccess;
  }
}
