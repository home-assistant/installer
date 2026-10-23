import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { localize } from "../localization/localize.js";
import {
  reducedMotionStyles,
  srOnlyStyles,
} from "../utils/view-accessibility.js";
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
  // The card in the shadow root takes the role, so that its heading can name
  // it and its description describe it: a reference from the host can't
  // reach into the shadow root. Focusing the host focuses the card.
  static shadowRootOptions = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static styles = [
    reducedMotionStyles,
    srOnlyStyles,
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

  /**
   * Opens a page in the browser rather than going on in the app, so it is a
   * link, and says that it opens in the browser.
   */
  @property({ type: Boolean })
  external = false;

  /** Space went down on the card, and comes up to act */
  private _spacePressed = false;

  render() {
    return html`
      <div
        class="card"
        role=${this.external ? "link" : "button"}
        tabindex="0"
        aria-labelledby="title"
        aria-describedby=${this.external
          ? "external description"
          : "description"}
        @keydown=${this._onKeyDown}
        @keyup=${this._onKeyUp}
        @blur=${this._onBlur}
      >
        <div class="icon-container">${this._renderIcon()}</div>
        <p class="title" id="title">${this.heading}</p>
        ${this.external
          ? html`<span class="sr-only" id="external"
              >${localize("components.option_card.opens_in_browser")}</span
            >`
          : nothing}
        <p class="description" id="description">${this.description}</p>
        <slot name="end"></slot>
      </div>
    `;
  }

  // The views attach `@click` to the host, so activating by keyboard just
  // re-dispatches a click rather than adding a second event to wire up.
  // As on a native button, Enter acts when it goes down and Space when it
  // comes up; a link takes only Enter, and Space scrolls. A held key acts
  // once: repeats would open an external page again and again.
  private _onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!e.repeat) this.click();
    } else if (e.key === " " && !this.external) {
      e.preventDefault();
      // A repeat belongs to a press that began where the key went down,
      // perhaps on another card before the focus moved here
      if (!e.repeat) this._spacePressed = true;
    }
  }

  private _onKeyUp(e: KeyboardEvent) {
    if (e.key === " " && this._spacePressed) {
      this._spacePressed = false;
      this.click();
    }
  }

  // Moving on with Space still down cancels it, as on a native button
  private _onBlur() {
    this._spacePressed = false;
  }

  // The heading names the card, so an alt would only have screen readers
  // announce the option twice when they read the card's contents.
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
