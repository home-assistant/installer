import { html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import WaRadio from "@home-assistant/webawesome/dist/components/radio/radio.js";
import { reducedMotionStyles } from "../utils/view-accessibility.js";
import {
  selectableCardStyles,
  selectedIndicatorStyles,
} from "../utils/card-styles.js";

/**
 * A device tile that behaves as a radio inside a `<wa-radio-group>`.
 *
 * Extending `WaRadio` rather than re-implementing it means the group's
 * `radioTag` wiring — roving tabindex, arrow-key navigation, `role="radio"`,
 * `aria-checked`/`aria-disabled` — all applies as-is; only the presentation
 * is ours. Selection state lives in `checked`, driven by the group.
 */
@customElement("device-card")
export class DeviceCard extends WaRadio {
  static css = [
    reducedMotionStyles,
    selectableCardStyles,
    selectedIndicatorStyles,
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

      .selected-indicator {
        position: absolute;
        top: 8px;
        inset-inline-end: 8px;
      }

      .card-wrapper {
        position: relative;
      }
    `,
  ];

  @property({ type: String })
  name = "";

  @property({ type: String })
  image = "";

  render() {
    return html`
      <div class="card-wrapper">
        <div class="card">
          <div class="image-container">${this._renderImage()}</div>
          <p class="name">${this.name}</p>
        </div>
        ${this.checked
          ? html`<span class="selected-indicator" aria-hidden="true">✓</span>`
          : nothing}
      </div>
    `;
  }

  // The card itself carries role="radio"/"button", so its accessible name is
  // computed from its contents. The visible name below already supplies that;
  // giving the image an alt would have screen readers announce it twice.
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
