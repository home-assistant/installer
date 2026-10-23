import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { reducedMotionStyles } from "../utils/view-accessibility.js";
import { selectableCardStyles } from "../utils/card-styles.js";
import { CardButton } from "./card-button.js";

/** A device tile. Picking it goes on to the next step. */
@customElement("device-card")
export class DeviceCard extends CardButton {
  static styles = [
    reducedMotionStyles,
    selectableCardStyles,
    css`
      .card {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 1.25rem;
        height: 180px;
      }

      .image-container {
        width: 100px;
        height: 100px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 0.75rem;
        flex-shrink: 0;
      }

      .image-container img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }

      .image-placeholder {
        width: 80px;
        height: 80px;
        background-color: var(--ha-primary-color, #03a9f4);
        border-radius: 12px;
        opacity: 0.2;
      }

      .name {
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--ha-text-color, #212121);
        text-align: center;
        margin: 0;
        line-height: 1.3;
        min-height: 2.6em;
        display: flex;
        align-items: center;
        justify-content: center;
      }
    `,
  ];

  @property({ type: String })
  name = "";

  @property({ type: String })
  image = "";

  render() {
    return html`
      <div
        class="card"
        role="button"
        tabindex="0"
        aria-labelledby="name"
        @keydown=${this._onKeyDown}
        @keyup=${this._onKeyUp}
        @blur=${this._onBlur}
      >
        <div class="image-container">${this._renderImage()}</div>
        <p class="name" id="name">${this.name}</p>
      </div>
    `;
  }

  // The name labels the card, so an alt would only have screen readers
  // announce the device twice when they read the card's contents.
  private _renderImage() {
    if (this.image) {
      return html`<img src=${this.image} alt="" />`;
    }
    return html`<div class="image-placeholder"></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "device-card": DeviceCard;
  }
}
