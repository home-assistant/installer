import { html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { localize } from "../localization/localize.js";
import {
  reducedMotionStyles,
  srOnlyStyles,
} from "../utils/view-accessibility.js";
import { selectableCardStyles } from "../utils/card-styles.js";
import {
  mdiChip,
  mdiDesktopTower,
  mdiDisc,
  mdiDotsHorizontal,
  mdiLaptop,
  mdiServer,
} from "../utils/icons.js";
import { CardButton } from "./card-button.js";

import "./ha-svg-icon.js";

// The processor makers' wordmarks, on the same 24 by 24 viewBox
const intelLogo =
  "M20.42 7.345v9.18h1.651v-9.18zM0 7.475v1.737h1.737V7.474zm9.78.352v6.053c0 .513.044.945.13 1.292.087.34.235.618.44.828.203.21.475.359.803.451.334.093.754.136 1.255.136h.216v-1.533c-.24 0-.445-.012-.593-.037a.672.672 0 0 1-.39-.173.693.693 0 0 1-.173-.377 4.002 4.002 0 0 1-.037-.606v-2.182h1.193v-1.416h-1.193V7.827zm-3.505 2.312c-.396 0-.76.08-1.082.241-.327.161-.6.384-.822.668l-.087.117v-.902H2.658v6.256h1.639v-3.214c.018-.588.16-1.02.433-1.299.29-.297.642-.445 1.044-.445.476 0 .841.149 1.082.433.235.284.359.686.359 1.2v3.324h1.663V12.97c.006-.89-.229-1.595-.686-2.09-.458-.495-1.1-.742-1.917-.742zm10.065.006a3.252 3.252 0 0 0-2.306.946c-.29.29-.525.637-.692 1.033a3.145 3.145 0 0 0-.254 1.273c0 .452.08.878.241 1.274.161.395.39.742.674 1.032.284.29.637.526 1.045.693.408.173.86.26 1.342.26 1.397 0 2.262-.637 2.782-1.23l-1.187-.904c-.248.297-.841.699-1.583.699-.464 0-.847-.105-1.138-.321a1.588 1.588 0 0 1-.593-.872l-.019-.056h4.915v-.587c0-.451-.08-.872-.235-1.267a3.393 3.393 0 0 0-.661-1.033 3.013 3.013 0 0 0-1.02-.692 3.345 3.345 0 0 0-1.311-.248zm-16.297.118v6.256h1.651v-6.256zm16.278 1.286c1.132 0 1.664.797 1.664 1.255l-3.32.006c0-.458.525-1.255 1.656-1.261zm7.073 3.814a.606.606 0 0 0-.606.606.606.606 0 0 0 .606.606.606.606 0 0 0 .606-.606.606.606 0 0 0-.606-.606zm-.008.105a.5.5 0 0 1 .002 0 .5.5 0 0 1 .5.501.5.5 0 0 1-.5.5.5.5 0 0 1-.5-.5.5.5 0 0 1 .498-.5zm-.233.155v.699h.13v-.285h.093l.173.285h.136l-.18-.297a.191.191 0 0 0 .118-.056c.03-.03.05-.074.05-.136 0-.068-.02-.117-.063-.154-.037-.038-.105-.056-.185-.056zm.13.099h.154c.019 0 .037.006.056.012a.064.064 0 0 1 .037.031c.013.013.012.031.012.056a.124.124 0 0 1-.012.055.164.164 0 0 1-.037.031c-.019.006-.037.013-.056.013h-.154Z";
const armLogo =
  "M5.419 8.534h1.614v6.911H5.419v-.72c-.71.822-1.573.933-2.07.933C1.218 15.658 0 13.882 0 11.985c0-2.253 1.542-3.633 3.37-3.633.507 0 1.4.132 2.049.984zm-3.765 3.491c0 1.198.751 2.202 1.918 2.202 1.015 0 1.959-.74 1.959-2.181 0-1.512-.934-2.233-1.959-2.233-1.167-.01-1.918.974-1.918 2.212zm7.297-3.49h1.613v.618a3 3 0 0 1 .67-.578c.314-.183.619-.233.984-.233.396 0 .822.06 1.269.324l-.66 1.462a1.432 1.432 0 0 0-.822-.244c-.345 0-.69.05-1.005.376-.446.477-.446 1.136-.446 1.593v3.582H8.94zm5.56 0h1.614v.639c.538-.66 1.177-.822 1.705-.822.72 0 1.4.345 1.786 1.015.579-.822 1.441-1.015 2.05-1.015.842 0 1.573.396 1.969 1.086.132.233.365.74.365 1.745v4.272h-1.614V11.65c0-.771-.08-1.086-.152-1.228-.101-.264-.345-.609-.923-.609-.396 0-.741.213-.954.508-.284.395-.315.984-.315 1.572v3.562H18.43V11.65c0-.771-.081-1.086-.152-1.228-.102-.264-.345-.609-.924-.609-.396 0-.74.213-.954.508-.284.395-.314.984-.314 1.572v3.562h-1.573";

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
  chip: mdiChip,
  intel: intelLogo,
  arm: armLogo,
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

/** A choice as a card. Picking it goes on, so the views attach `@click`. */
@customElement("option-card")
export class OptionCard extends CardButton {
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

  // A link takes only Enter, and Space scrolls
  protected get _spaceActs() {
    return !this.external;
  }

  // More under the description goes in the default slot, and describes the
  // card with it
  render() {
    return html`
      <div
        class="card"
        role=${this.external ? "link" : "button"}
        tabindex="0"
        aria-labelledby="title"
        aria-describedby=${this.external
          ? "external description more"
          : "description more"}
        @keydown=${this._onKeyDown}
        @keyup=${this._onKeyUp}
        @blur=${this._onBlur}
      >
        <div class="icon-container">${this._renderIcon()}</div>
        <p class="title" id="title">${this.heading}</p>
        ${this.external
          ? html`<span class="sr-only" id="external"
              >${localize("common.opens_in_browser")}</span
            >`
          : nothing}
        <p class="description" id="description">${this.description}</p>
        <slot id="more"></slot>
        <slot name="end"></slot>
      </div>
    `;
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
