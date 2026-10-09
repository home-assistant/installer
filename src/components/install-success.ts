import { LitElement, html, css, svg, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { localize } from "../localization/localize.js";
import { openExternalLink } from "../utils/external-url.js";
import { renderCasitaHappy } from "./install-mascot.js";
import {
  ReducedSvgMotion,
  ViewAccessibility,
  reducedMotionStyles,
} from "../utils/view-accessibility.js";

@customElement("install-success")
export class InstallSuccess extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  protected readonly _svgMotion = new ReducedSvgMotion(this);

  static styles = css`
    ${reducedMotionStyles}
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
      text-align: center;
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
      color: var(--ha-text-color, #212121);
      margin: 0 0 0.5rem 0;
    }

    .subtitle {
      font-size: 1rem;
      color: var(--ha-secondary-text-color, #727272);
      margin: 0 0 2rem 0;
    }

    .next-steps {
      width: 100%;
      max-width: 500px;
      text-align: left;
      margin-bottom: 2rem;
    }

    .next-steps-title {
      font-size: 0.875rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--ha-secondary-text-color, #727272);
      margin: 0 0 1rem 0;
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
      background-color: var(--ha-primary-fill, #006787);
      color: white;
      font-size: 0.875rem;
      font-weight: 500;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .step-text {
      font-size: 1rem;
      color: var(--ha-text-color, #212121);
      line-height: 1.5;
      padding-top: 2px;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .next-steps a {
      color: var(--ha-primary-color, #03a9f4);
      text-decoration: none;
      font-weight: 500;
    }

    .next-steps a:hover {
      text-decoration: underline;
    }

    .companion-section {
      width: 100%;
      max-width: 500px;
      padding: 1.5rem;
      background-color: var(--ha-card-background, #ffffff);
      border: 1px solid var(--ha-border-color, #e0e0e0);
      border-radius: 12px;
      margin-bottom: 2rem;
    }

    @media (prefers-color-scheme: dark) {
      .companion-section {
        background-color: var(--ha-card-background, #1e1e1e);
        border-color: var(--ha-border-color, #333333);
      }
    }

    .companion-title {
      font-size: 1rem;
      font-weight: 500;
      color: var(--ha-text-color, #212121);
      margin: 0 0 1rem 0;
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
      background-color: var(--ha-background-color, #f5f5f5);
      border: 1px solid var(--ha-border-color, #e0e0e0);
      border-radius: 8px;
      color: var(--ha-text-color, #212121);
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 500;
      transition: all 0.2s ease;
    }

    .app-link:hover {
      background-color: var(--ha-primary-fill, #006787);
      border-color: var(--ha-primary-color, #03a9f4);
      color: white;
    }

    .app-link:hover svg {
      fill: white;
    }

    @media (prefers-color-scheme: dark) {
      .app-link {
        background-color: var(--ha-background-color, #2d2d2d);
        border-color: var(--ha-border-color, #444444);
      }
    }

    .app-link svg {
      width: 20px;
      height: 20px;
      fill: var(--ha-text-color, #212121);
      transition: fill 0.2s ease;
    }

    @media (prefers-color-scheme: dark) {
      .app-link svg {
        fill: var(--ha-text-color, #e0e0e0);
      }
    }

    .tip-section {
      width: 100%;
      max-width: 500px;
      padding: 1rem;
      background-color: rgba(3, 169, 244, 0.1);
      border-radius: 8px;
      font-size: 0.875rem;
      color: var(--ha-text-color, #212121);
      text-align: left;
    }

    .notice {
      padding: 0.75rem 0 0.75rem 1rem;
      border-left: 3px solid var(--ha-warning-color, #f5a623);
      line-height: 1.5;
      margin: 1.25rem 0;
    }

    .next-steps-footer {
      margin: 1.25rem 0 0;
    }

    .tip-section strong {
      color: var(--ha-primary-color, #03a9f4);
    }
  `;
  @property({ attribute: false }) subtitle: string | TemplateResult = "";
  @property({ attribute: false }) steps: (string | TemplateResult)[] = [];
  @property({ attribute: false }) tip: string | TemplateResult = "";
  /** Shown above the steps, for something to avoid before starting them. */
  @property({ attribute: false }) notice: string | TemplateResult = "";
  /** Shown below the steps, such as a link to further documentation. */
  @property({ attribute: false }) footer: string | TemplateResult = "";

  render() {
    const title = localize("views.proxmox.proxmox_success_view.you_re_all_set");

    return html`
      <div class="mascot-container" aria-hidden="true">
        ${renderCasitaHappy()}
      </div>
      <div role="alert">
        <h2>${title}</h2>
      </div>
      <p class="subtitle">${this.subtitle}</p>
      <div class="next-steps">
        <p class="next-steps-title">
          ${localize("views.proxmox.proxmox_success_view.next_steps")}
        </p>
        ${this.notice ? html`<p class="notice">${this.notice}</p>` : ""}
        <ol
          class="steps-list"
          role="list"
          aria-label=${localize(
            "views.proxmox.proxmox_success_view.next_steps"
          )}
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
      ${this.tip ? html`<div class="tip-section">${this.tip}</div>` : ""}
      <div class="companion-section">
        <p class="companion-title">
          ${localize(
            "views.proxmox.proxmox_success_view.get_the_home_assistant_companion_app"
          )}
        </p>
        <div class="app-links">
          <a
            class="app-link"
            href="https://apps.apple.com/app/home-assistant/id1099568401"
            target="_blank"
            rel="noopener noreferrer"
            @click=${(event: Event) =>
              openExternalLink(
                event,
                "https://apps.apple.com/app/home-assistant/id1099568401"
              )}
          >
            ${this._renderAppleIcon()}
            <span
              >${localize("views.proxmox.proxmox_success_view.app_store")}</span
            >
          </a>
          <a
            class="app-link"
            href="https://play.google.com/store/apps/details?id=io.homeassistant.companion.android"
            target="_blank"
            rel="noopener noreferrer"
            @click=${(event: Event) =>
              openExternalLink(
                event,
                "https://play.google.com/store/apps/details?id=io.homeassistant.companion.android"
              )}
          >
            ${this._renderGooglePlayIcon()}
            <span
              >${localize(
                "views.proxmox.proxmox_success_view.google_play"
              )}</span
            >
          </a>
        </div>
      </div>
    `;
  }

  private _renderAppleIcon() {
    return svg`
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
      </svg>
    `;
  }

  private _renderGooglePlayIcon() {
    return svg`
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M3,20.5V3.5C3,2.91 3.34,2.39 3.84,2.15L13.69,12L3.84,21.85C3.34,21.6 3,21.09 3,20.5M16.81,15.12L6.05,21.34L14.54,12.85L16.81,15.12M20.16,10.81C20.5,11.08 20.75,11.5 20.75,12C20.75,12.5 20.53,12.9 20.18,13.18L17.89,14.5L15.39,12L17.89,9.5L20.16,10.81M6.05,2.66L16.81,8.88L14.54,11.15L6.05,2.66Z"/>
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "install-success": InstallSuccess;
  }
}
