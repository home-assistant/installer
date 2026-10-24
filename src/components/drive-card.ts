import { html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import WaRadio from "@home-assistant/webawesome/dist/components/radio/radio.js";
import type { DeviceType } from "../api/types.js";
import { formatBytes } from "../utils/format.js";
import { localize } from "../localization/localize.js";
import { renderDriveIcon } from "./drive-icon.js";
import { driveModelLabel } from "../utils/drive-selection.js";
import { reducedMotionStyles } from "../utils/view-accessibility.js";
import {
  selectableCardStyles,
  selectedIndicatorStyles,
} from "../utils/card-styles.js";

/**
 * A drive row that behaves as a radio inside a `<wa-radio-group>`.
 *
 * Extending `WaRadio` keeps the group's keyboard handling, roving tabindex
 * and ARIA; only the presentation is ours. See {@link DeviceCard}.
 *
 * The `value` is the device path, e.g. "/dev/sda" or "\\.\PhysicalDrive2",
 * and the card shows it: it is the one thing that tells two identical sticks
 * apart, and what the confirm step shows. It is on every card, not only on
 * look-alikes, so a card and its accessible name don't change as other drives
 * come and go.
 */
@customElement("drive-card")
export class DriveCard extends WaRadio {
  static css = [
    reducedMotionStyles,
    selectableCardStyles,
    selectedIndicatorStyles,
    css`
      :host(:state(disabled)) {
        cursor: not-allowed;
      }

      .card {
        display: grid;
        grid-template-columns: 48px minmax(0, 1fr) auto 24px;
        align-items: center;
        gap: 1rem;
        padding: 1rem 1.25rem;
      }

      /* Fade what marks the drive as unavailable, but not the reason it is:
       * that line is all the explanation the user gets, so it keeps its
       * contrast */
      :host(:state(disabled)) .card {
        border-color: color-mix(
          in srgb,
          var(--ha-border-color) 50%,
          transparent
        );
        pointer-events: none;
      }

      :host(:state(disabled)) :is(.icon-container, .name, .size) {
        opacity: 0.5;
      }

      .icon-container {
        width: 48px;
        height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      .icon-container svg {
        width: 40px;
        height: 40px;
        fill: var(--ha-secondary-text-color);
      }

      :host(:state(checked)) .icon-container svg {
        fill: var(--ha-primary-color);
      }

      /* A long name wraps, even mid-word, so the whole of it shows; so do
         the vendor and model below it, which repeat its parts */
      .info {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .name {
        font-size: 1rem;
        font-weight: 500;
        color: var(--ha-text-color);
        margin: 0 0 0.25rem 0;
      }

      .details {
        font-size: 0.8125rem;
        color: var(--ha-secondary-text-color);
        margin: 0;
      }

      .path {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.8125rem;
        color: var(--ha-secondary-text-color);
        margin: 0.125rem 0 0 0;
        overflow-wrap: anywhere;
      }

      .size {
        font-size: 1rem;
        font-weight: 500;
        color: var(--ha-text-color);
        flex-shrink: 0;
      }

      .capacity-warning {
        grid-column: 1 / -1;
        color: var(--wa-color-warning-on-quiet);
        font-size: 0.8125rem;
        margin: 0;
      }

      /* In forced colors, a drive that can't be picked takes the system's
       * color for disabled text, which is meant to be read, instead of
       * fading */
      @media (forced-colors: active) {
        :host(:state(disabled)) .card {
          border-color: GrayText;
        }

        :host(:state(disabled)) :is(.card, .card *) {
          opacity: 1;
        }

        :host(:state(disabled)) :is(.name, .details, .size) {
          color: GrayText;
        }

        :host(:state(disabled)) .icon-container svg {
          fill: GrayText;
        }
      }

      @media (max-width: 480px) {
        .card {
          grid-template-columns: 32px minmax(0, 1fr) auto 24px;
          gap: 0.75rem;
          padding: 1rem;
        }

        .icon-container,
        .icon-container svg {
          width: 32px;
          height: 32px;
        }
      }
    `,
  ];

  @property({ type: String })
  name = "";

  /**
   * Drive size in bytes. Named `driveSize` rather than `size` because WaRadio
   * uses `size` for its t-shirt sizing; `diskSize` is taken by the VM flows'
   * virtual disk. Matches the `driveSize` wizard-state selection.
   */
  @property({ type: Number, attribute: "drive-size" })
  driveSize = 0;

  @property({ type: String, attribute: "device-type" })
  deviceType: DeviceType = "unknown";

  @property({ type: String })
  model = "";

  @property({ type: String })
  vendor = "";

  @property({ type: String, attribute: "disabled-reason" })
  disabledReason = "";

  @property({ type: String, attribute: "capacity-warning" })
  capacityWarning = "";

  render() {
    return html`
      <div class="card">
        <!-- A picture of the drive's kind; the details name the drive -->
        <div class="icon-container" aria-hidden="true">
          ${renderDriveIcon(this.deviceType)}
        </div>
        <div class="info">
          <p class="name">${this.name}</p>
          <p class="details">
            ${this.disabled && this.disabledReason
              ? this.disabledReason
              : this._getDetails()}
          </p>
          ${this.value
            ? html`<p class="path"><bdi>${this.value}</bdi></p>`
            : nothing}
        </div>
        <span class="size">${formatBytes(this.driveSize)}</span>
        ${this.checked
          ? html`<span class="selected-indicator" aria-hidden="true">✓</span>`
          : nothing}
        ${!this.disabled && this.capacityWarning
          ? html`<p class="capacity-warning">${this.capacityWarning}</p>`
          : nothing}
      </div>
    `;
  }

  private _getDetails(): string {
    return driveModelLabel(this.vendor, this.model) || this._getTypeLabel();
  }

  private _getTypeLabel(): string {
    switch (this.deviceType) {
      case "sd_card":
        return localize("components.drive_card.sd_card");
      case "usb_drive":
        return localize("components.drive_card.usb_drive");
      case "ssd":
        return localize("components.drive_card.ssd");
      case "hdd":
        return localize("components.drive_card.hard_drive");
      case "nvme":
        return localize("components.drive_card.nvme");
      default:
        return localize("components.drive_card.storage_device");
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "drive-card": DriveCard;
  }
}
