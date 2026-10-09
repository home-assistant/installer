import { html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import WaRadio from "@home-assistant/webawesome/dist/components/radio/radio.js";
import { reducedMotionStyles } from "../utils/view-accessibility.js";

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
    css`
      @media (prefers-reduced-motion: reduce) {
        .card:active {
          transform: none !important;
        }
      }
      :host {
        display: block;
        outline: none;
        cursor: pointer;
      }

      :host(:state(disabled)) {
        cursor: not-allowed;
      }

      .card {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 1.25rem;
        height: 180px;
        box-sizing: border-box;
        background-color: var(--wa-color-surface-default);
        border: 2px solid var(--wa-color-surface-border);
        border-radius: var(--wa-panel-border-radius);
        transition:
          border-color 0.2s ease,
          box-shadow 0.2s ease,
          transform 0.1s ease;
      }

      .card:hover {
        border-color: var(--ha-primary-color, #03a9f4);
        box-shadow: var(--wa-shadow-s);
      }

      .card:active {
        transform: scale(0.98);
      }

      :host(:state(checked)) .card {
        border-color: var(--ha-primary-color, #03a9f4);
        box-shadow: 0 0 0 3px rgba(3, 169, 244, 0.2);
      }

      :host(:focus-visible) .card {
        outline: var(--wa-focus-ring);
        outline-offset: var(--wa-focus-ring-offset);
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
        color: var(--wa-color-text-normal);
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
        right: 8px;
        width: 24px;
        height: 24px;
        background-color: var(--ha-primary-fill, #006787);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--wa-color-brand-on-loud, white);
        font-size: 14px;
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
