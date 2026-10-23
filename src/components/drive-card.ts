import { html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import WaRadio from "@home-assistant/webawesome/dist/components/radio/radio.js";
import type { DeviceType } from "../api/types.js";
import { formatBytes } from "../api/commands.js";
import { localize } from "../localization/localize.js";
import { renderDriveIcon } from "./drive-icon.js";
import { reducedMotionStyles } from "../utils/view-accessibility.js";

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

      :host(:focus-visible) .card {
        outline: var(--wa-focus-ring);
        outline-offset: var(--wa-focus-ring-offset);
      }

      .card {
        display: grid;
        grid-template-columns: 48px minmax(0, 1fr) auto 24px;
        align-items: center;
        gap: 1rem;
        padding: 1rem 1.25rem;
        background-color: var(--ha-card-background, #ffffff);
        border: 2px solid var(--ha-border-color, #e0e0e0);
        border-radius: var(--ha-card-border-radius, 12px);
        transition:
          border-color 0.2s ease,
          box-shadow 0.2s ease,
          transform 0.1s ease;
      }

      .card:hover {
        border-color: var(--ha-primary-color, #03a9f4);
        box-shadow: var(--ha-card-hover-shadow);
      }

      .card:active {
        transform: scale(0.99);
      }

      :host(:state(checked)) .card {
        border-color: var(--ha-primary-color, #03a9f4);
        box-shadow: var(--ha-card-selected-shadow);
      }

      :host(:state(disabled)) .card {
        opacity: 0.5;
        pointer-events: none;
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
        fill: var(--ha-secondary-text-color, #727272);
      }

      :host(:state(checked)) .icon-container svg {
        fill: var(--ha-primary-color, #03a9f4);
      }

      .info {
        flex: 1;
        min-width: 0;
      }

      .name {
        font-size: 1rem;
        font-weight: 500;
        color: var(--ha-text-color, #212121);
        margin: 0 0 0.25rem 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .details {
        font-size: 0.8125rem;
        color: var(--ha-secondary-text-color, #727272);
        margin: 0;
      }

      .path {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.8125rem;
        color: var(--ha-secondary-text-color, #727272);
        margin: 0.125rem 0 0 0;
        overflow-wrap: anywhere;
      }

      .size {
        font-size: 1rem;
        font-weight: 500;
        color: var(--ha-text-color, #212121);
        flex-shrink: 0;
      }

      .capacity-warning {
        grid-column: 1 / -1;
        color: var(--wa-color-warning-on-quiet);
        font-size: 0.8125rem;
        margin: 0;
      }

      .selected-indicator {
        width: 24px;
        height: 24px;
        background-color: var(--ha-primary-fill, #006787);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--wa-color-brand-on-loud, white);
        font-size: 14px;
        flex-shrink: 0;
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
        <div class="icon-container">${renderDriveIcon(this.deviceType)}</div>
        <div class="info">
          <p class="name">${this.name}</p>
          <p class="details">
            ${this.disabled && this.disabledReason
              ? this.disabledReason
              : this._getDetails()}
          </p>
          ${this.value ? html`<p class="path">${this.value}</p>` : nothing}
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
    const parts: string[] = [];
    // Models often start with their vendor already ("Samsung EVO Plus")
    const vendorInModel =
      this.vendor &&
      `${this.model.toLowerCase()} `.startsWith(
        `${this.vendor.toLowerCase()} `
      );
    if (this.vendor && !vendorInModel) parts.push(this.vendor);
    if (this.model) parts.push(this.model);
    if (parts.length === 0) {
      parts.push(this._getTypeLabel());
    }
    return parts.join(" ");
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
