import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { reducedMotionStyles } from "../utils/view-accessibility.js";

import "./ha-svg-icon.js";

// Material Design Icons, matching the shared ha-svg-icon convention.
const mdiDesktopTower =
  "M8,2H16A2,2 0 0,1 18,4V20A2,2 0 0,1 16,22H8A2,2 0 0,1 6,20V4A2,2 0 0,1 8,2M8,4V6H16V4H8M16,8H8V10H16V8M16,18H14V20H16V18Z";
const mdiServer =
  "M4,1H20A1,1 0 0,1 21,2V6A1,1 0 0,1 20,7H4A1,1 0 0,1 3,6V2A1,1 0 0,1 4,1M4,9H20A1,1 0 0,1 21,10V14A1,1 0 0,1 20,15H4A1,1 0 0,1 3,14V10A1,1 0 0,1 4,9M4,17H20A1,1 0 0,1 21,18V22A1,1 0 0,1 20,23H4A1,1 0 0,1 3,22V18A1,1 0 0,1 4,17M9,5H10V3H9V5M9,13H10V11H9V13M9,21H10V19H9V21M5,3V5H7V3H5M5,11V13H7V11H5M5,19V21H7V19H5Z";
const mdiLaptop =
  "M4,6H20V16H4M20,18A2,2 0 0,0 22,16V6C22,4.89 21.1,4 20,4H4C2.89,4 2,4.89 2,6V16A2,2 0 0,0 4,18H0V20H24V18H20Z";
const mdiDotsHorizontal =
  "M16,12A2,2 0 0,1 18,10A2,2 0 0,1 20,12A2,2 0 0,1 18,14A2,2 0 0,1 16,12M10,12A2,2 0 0,1 12,10A2,2 0 0,1 14,12A2,2 0 0,1 12,14A2,2 0 0,1 10,12M4,12A2,2 0 0,1 6,10A2,2 0 0,1 8,12A2,2 0 0,1 6,14A2,2 0 0,1 4,12Z";

@customElement("option-card")
export class OptionCard extends LitElement {
  static styles = css`
    ${reducedMotionStyles}
    @media (prefers-reduced-motion: reduce) {
      .card:active {
        transform: none !important;
      }
    }
    :host {
      display: block;
      outline: none;
    }

    :host(:focus-visible) .card {
      outline: var(--wa-focus-ring);
      outline-offset: var(--wa-focus-ring-offset);
    }

    .card {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 1.5rem;
      min-height: 200px;
      background-color: var(--ha-card-background, #ffffff);
      border: 2px solid var(--ha-border-color, #e0e0e0);
      border-radius: 12px;
      cursor: pointer;
      transition:
        border-color 0.2s ease,
        box-shadow 0.2s ease,
        transform 0.1s ease;
    }

    .card:hover {
      border-color: var(--ha-primary-color, #03a9f4);
      box-shadow: 0 4px 12px rgba(3, 169, 244, 0.15);
    }

    .card:active {
      transform: scale(0.98);
    }

    @media (prefers-color-scheme: dark) {
      .card {
        background-color: var(--ha-card-background, #1e1e1e);
        border-color: var(--ha-border-color, #333333);
      }

      .card:hover {
        box-shadow: 0 4px 12px rgba(3, 169, 244, 0.25);
      }
    }

    :host([horizontal]) .card {
      display: grid;
      grid-template-columns: 48px minmax(0, 1fr) auto;
      gap: 0.25rem 1rem;
      min-height: 0;
      align-items: center;
    }

    :host([horizontal]) .icon-container {
      grid-row: span 2;
      width: 48px;
      height: 48px;
      margin: 0;
    }

    :host([horizontal]) .title,
    :host([horizontal]) .description {
      grid-column: 2;
      text-align: left;
      margin: 0;
    }

    :host([horizontal]) slot[name="end"] {
      display: block;
      grid-column: 3;
      grid-row: 1 / span 2;
      color: var(--ha-secondary-text-color, #9e9e9e);
      font-size: 1.25rem;
    }

    .icon-container {
      width: 80px;
      height: 80px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 1rem;
    }

    .icon-container img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }

    ha-svg-icon {
      --mdc-icon-size: 100%;
      color: var(--ha-primary-color, #03a9f4);
    }

    .title {
      font-size: 1rem;
      font-weight: 500;
      color: var(--ha-text-color, #212121);
      text-align: center;
      margin: 0 0 0.5rem 0;
    }

    .description {
      font-size: 0.8125rem;
      color: var(--ha-secondary-text-color, #727272);
      text-align: center;
      line-height: 1.4;
      margin: 0;
    }
  `;

  @property({ type: Boolean, reflect: true })
  horizontal = false;

  @property({ type: String })
  title = "";

  @property({ type: String })
  description = "";

  @property({ type: String })
  icon = "";

  @property({ type: String })
  image = "";

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "button");
    this.setAttribute("tabindex", "0");
    this.addEventListener("keydown", this._onKeyDown);
  }

  disconnectedCallback() {
    this.removeEventListener("keydown", this._onKeyDown);
    super.disconnectedCallback();
  }

  // The views attach `@click` to the host, so activating by keyboard just
  // re-dispatches a click rather than adding a second event to wire up.
  private _onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.click();
    }
  };

  render() {
    return html`
      <div class="card">
        <div class="icon-container">${this._renderIcon()}</div>
        <p class="title">${this.title}</p>
        <p class="description">${this.description}</p>
        <slot name="end"></slot>
      </div>
    `;
  }

  // The card itself carries role="button", so its accessible name is
  // computed from its contents. The visible name below already supplies that;
  // giving the image an alt would have screen readers announce it twice.
  private _renderIcon() {
    if (this.image) {
      return html`<img src=${this.image} alt="" />`;
    }

    const images: Record<string, string> = {
      sbc: "/assets/devices/raspberry_pi_5.png",
      "ha-hardware": "/assets/icons/home-assistant-hardware.svg",
    };

    const iconSrc = Object.prototype.hasOwnProperty.call(images, this.icon)
      ? images[this.icon]
      : "";
    if (iconSrc) {
      return html`<img src=${iconSrc} alt="" />`;
    }

    const paths: Record<string, string> = {
      minipc: mdiDesktopTower,
      proxmox: mdiServer,
      vm: mdiLaptop,
      others: mdiDotsHorizontal,
    };
    return html`<ha-svg-icon
      .path=${Object.prototype.hasOwnProperty.call(paths, this.icon)
        ? paths[this.icon]
        : mdiDotsHorizontal}
    ></ha-svg-icon>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "option-card": OptionCard;
  }
}
