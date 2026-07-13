import "@home-assistant/webawesome/dist/components/button/button.js";
import "@home-assistant/webawesome/dist/components/tooltip/tooltip.js";
import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import "./ha-svg-icon.js";

/**
 * Floating action button: a circular, icon-only wa-button pinned to the
 * bottom-right, with a wa-tooltip describing the action. Pass the icon as an
 * MDI `path` and the accessible name / tooltip text as `label`, mirroring the
 * Home Assistant frontend `ha-icon-button` API.
 */
@customElement("fab-button")
export class FabButton extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      bottom: 1.5rem;
      right: 1.5rem;
      z-index: 100;
    }

    wa-button {
      display: block;
      transition: transform 0.2s ease;
      --mdc-icon-size: 28px;
    }

    wa-button::part(base) {
      width: 56px;
      height: 56px;
      padding: 0;
      border-radius: 50%;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      transition: box-shadow 0.2s ease;
    }

    :host(:hover) wa-button {
      transform: scale(1.05);
    }

    :host(:hover) wa-button::part(base) {
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
    }

    wa-button:active {
      transform: scale(0.98);
    }
  `;

  /** MDI icon path drawn inside the button. */
  @property() path?: string;

  /** Accessible name, also shown as the tooltip. */
  @property() label?: string;

  render() {
    return html`
      <wa-button
        id="button"
        variant="brand"
        appearance="accent"
        aria-label=${ifDefined(this.label)}
      >
        <ha-svg-icon .path=${this.path}></ha-svg-icon>
      </wa-button>
      ${this.label
        ? html`<wa-tooltip for="button" placement="left"
            >${this.label}</wa-tooltip
          >`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "fab-button": FabButton;
  }
}
