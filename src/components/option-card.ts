import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { reducedMotionStyles } from "../utils/view-accessibility.js";
import { selectableCardStyles } from "../utils/card-styles.js";
import { mdiServer } from "../utils/icons.js";

import "./ha-svg-icon.js";

// Material Design Icons, matching the shared ha-svg-icon convention.
const mdiDesktopTower =
  "M8,2H16A2,2 0 0,1 18,4V20A2,2 0 0,1 16,22H8A2,2 0 0,1 6,20V4A2,2 0 0,1 8,2M8,4V6H16V4H8M16,8H8V10H16V8M16,18H14V20H16V18Z";
const mdiLaptop =
  "M4,6H20V16H4M20,18A2,2 0 0,0 22,16V6C22,4.89 21.1,4 20,4H4C2.89,4 2,4.89 2,6V16A2,2 0 0,0 4,18H0V20H24V18H20Z";
const mdiDotsHorizontal =
  "M16,12A2,2 0 0,1 18,10A2,2 0 0,1 20,12A2,2 0 0,1 18,14A2,2 0 0,1 16,12M10,12A2,2 0 0,1 12,10A2,2 0 0,1 14,12A2,2 0 0,1 12,14A2,2 0 0,1 10,12M4,12A2,2 0 0,1 6,10A2,2 0 0,1 8,12A2,2 0 0,1 6,14A2,2 0 0,1 4,12Z";
const mdiDisc =
  "M12,14C10.89,14 10,13.1 10,12C10,10.89 10.89,10 12,10C13.11,10 14,10.89 14,12A2,2 0 0,1 12,14M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z";

// Single-color icon files. They are drawn as a mask in the icon color, so
// they match the MDI icons in light and dark mode.
const ICON_FILES = {
  "ha-hardware": "/assets/icons/home-assistant-hardware.svg",
  "drive-connect": "/assets/icons/drive-connect.svg",
  "usb-boot": "/assets/icons/usb-boot.svg",
  docker: "/assets/icons/docker.svg",
  synology: "/assets/icons/synology.svg",
  qnap: "/assets/icons/qnap.svg",
  linux: "/assets/icons/linux.svg",
  windows: "/assets/icons/windows.svg",
};

const ICON_PATHS = {
  minipc: mdiDesktopTower,
  proxmox: mdiServer,
  vm: mdiLaptop,
  disc: mdiDisc,
  others: mdiDotsHorizontal,
};

/** The icons an option card can show; `sbc` is a photo of a board. */
export type OptionCardIcon =
  | "sbc"
  | keyof typeof ICON_FILES
  | keyof typeof ICON_PATHS;

// An attribute in a template isn't type-checked, so look the icon up as any
// string, and only among the map's own keys
function hasIcon<T extends object>(
  icons: T,
  icon: string
): icon is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(icons, icon);
}

@customElement("option-card")
export class OptionCard extends LitElement {
  static styles = [
    reducedMotionStyles,
    selectableCardStyles,
    css`
      /* Fills a stretched grid cell, so cards in one row end level */
      .card {
        display: flex;
        flex-direction: column;
        align-items: center;
        height: 100%;
        padding: 1.5rem;
        min-height: 200px;
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
        text-align: start;
        margin: 0;
      }

      :host([horizontal]) slot[name="end"] {
        display: block;
        grid-column: 3;
        grid-row: 1 / span 2;
        color: var(--ha-secondary-text-color, #9e9e9e);
        font-size: 1.25rem;
      }

      /* Its arrow points the way the page reads. WebKit doesn't match :dir()
         on the slot itself. */
      :host([horizontal]:dir(rtl)) slot[name="end"] {
        transform: scaleX(-1);
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

      .icon-file {
        width: 100%;
        height: 100%;
        background-color: var(--ha-primary-color, #03a9f4);
        -webkit-mask: var(--icon-file) center / contain no-repeat;
        mask: var(--icon-file) center / contain no-repeat;
      }

      /* Forced colors would paint the mask's background like the card */
      @media (forced-colors: active) {
        .icon-file {
          forced-color-adjust: none;
          background-color: CanvasText;
        }
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
    `,
  ];

  @property({ type: Boolean, reflect: true })
  horizontal = false;

  @property({ type: String, reflect: true })
  heading = "";

  @property({ type: String })
  description = "";

  @property({ type: String })
  icon: OptionCardIcon = "others";

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
        <p class="title">${this.heading}</p>
        <p class="description">${this.description}</p>
        <slot name="end"></slot>
      </div>
    `;
  }

  // The card itself carries role="button", so its accessible name is
  // computed from its contents. The visible name below already supplies that;
  // giving the image an alt would have screen readers announce it twice.
  private _renderIcon() {
    const icon: string = this.icon;
    if (icon === "sbc") {
      return html`<img src="/assets/devices/raspberry_pi_5.png" alt="" />`;
    }

    if (hasIcon(ICON_FILES, icon)) {
      return html`<span
        class="icon-file"
        style=${styleMap({ "--icon-file": `url(${ICON_FILES[icon]})` })}
      ></span>`;
    }

    return html`<ha-svg-icon
      .path=${hasIcon(ICON_PATHS, icon) ? ICON_PATHS[icon] : mdiDotsHorizontal}
    ></ha-svg-icon>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "option-card": OptionCard;
  }
}
