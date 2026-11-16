import { LitElement, css, html } from "lit";
import { customElement, query } from "lit/decorators.js";
import type WaButton from "@home-assistant/webawesome/dist/components/button/button.js";
import type WaRadioGroup from "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import "@home-assistant/webawesome/dist/components/radio/radio.js";
import { getLanguage, localize } from "../localization/localize.js";
import { mdiHuman, mdiMinus, mdiPlus } from "../utils/icons.js";
import {
  TEXT_SIZES,
  TEXT_SIZE_CHANGE,
  stepTextSize,
  textSize,
} from "../utils/text-size.js";
import { type Theme, setTheme, theme } from "../utils/theme.js";
import "./ha-svg-icon.js";
import "./header-menu.js";

/** The theme and the text size, at the end of every screen's header */
@customElement("accessibility-menu")
export class AccessibilityMenu extends LitElement {
  @query(".smaller")
  private _smaller!: WaButton;

  @query(".larger")
  private _larger!: WaButton;

  // Ctrl or Cmd with + and − change the size too
  private readonly _onTextSizeChanged = () => this.requestUpdate();

  static styles = css`
    /* One row, like Zoom in a browser's menu, in the type of Theme above */
    .text-size {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      font-size: var(--wa-font-size-s);
      line-height: var(--wa-form-control-label-line-height);
    }

    .label {
      font-weight: var(--wa-form-control-label-font-weight);
    }

    .stepper {
      display: flex;
      align-items: center;
    }

    /* As wide as the widest size, so − and + stay put while it changes */
    .stepper span {
      min-width: 3.5em;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }

    .stepper wa-button {
      --wa-form-control-height: 1.75rem;
    }

    .stepper wa-button::part(base) {
      width: var(--wa-form-control-height);
      padding: 0;
    }

    .stepper ha-svg-icon {
      --mdc-icon-size: 1.125rem;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(TEXT_SIZE_CHANGE, this._onTextSizeChanged);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener(TEXT_SIZE_CHANGE, this._onTextSizeChanged);
  }

  render() {
    const size = TEXT_SIZES.indexOf(textSize());
    const percent = new Intl.NumberFormat(getLanguage(), { style: "percent" });
    return html`<header-menu
      label=${localize("components.accessibility_menu.accessibility")}
      .icon=${mdiHuman}
    >
      <wa-radio-group
        label=${localize("components.accessibility_menu.theme")}
        size="s"
        .value=${theme()}
        @change=${this._onThemeChange}
      >
        <wa-radio value="system"
          >${localize("components.accessibility_menu.match_system")}</wa-radio
        >
        <wa-radio value="light"
          >${localize("components.accessibility_menu.light")}</wa-radio
        >
        <wa-radio value="dark"
          >${localize("components.accessibility_menu.dark")}</wa-radio
        >
      </wa-radio-group>
      <div class="text-size" role="group" aria-labelledby="text-size">
        <div class="label" id="text-size">
          ${localize("components.accessibility_menu.text_size")}
        </div>
        <div class="stepper">
          <wa-button
            class="smaller"
            accessible-label=${localize(
              "components.accessibility_menu.smaller"
            )}
            appearance="plain"
            pill
            ?disabled=${size === 0}
            @click=${this._onSmaller}
          >
            <ha-svg-icon .path=${mdiMinus}></ha-svg-icon>
          </wa-button>
          <span aria-live="polite">${percent.format(textSize())}</span>
          <wa-button
            class="larger"
            accessible-label=${localize("components.accessibility_menu.larger")}
            appearance="plain"
            pill
            ?disabled=${size === TEXT_SIZES.length - 1}
            @click=${this._onLarger}
          >
            <ha-svg-icon .path=${mdiPlus}></ha-svg-icon>
          </wa-button>
        </div>
      </div>
    </header-menu>`;
  }

  private _onThemeChange(event: Event) {
    setTheme((event.target as WaRadioGroup).value as Theme);
  }

  private _onSmaller() {
    void this._step(-1);
  }

  private _onLarger() {
    void this._step(1);
  }

  private async _step(by: number) {
    stepTextSize(by);
    await this.updateComplete;
    // At either end of the range its button turns off, so the focus moves to
    // the other one rather than leaving the panel
    if (this._smaller.disabled) this._larger.focus();
    if (this._larger.disabled) this._smaller.focus();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "accessibility-menu": AccessibilityMenu;
  }
}
