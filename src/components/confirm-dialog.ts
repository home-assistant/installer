import { localize, localizeContent } from "../localization/localize.js";
import { html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import { formatBytes } from "../api/index.js";
import { getPlatform } from "../utils/platform.js";
import { DialogBase } from "./dialog-base.js";

/**
 * Destructive confirmation dialog built on DialogBase.
 *
 * Toggle `open`, describe the target with `driveName` / `drivePath` /
 * `driveModel` / `driveSize`, and listen for `dialog-confirm` /
 * `dialog-cancel`. Escape, backdrop click, and the header close button all
 * map to `dialog-cancel`.
 *
 * The device path is shown because it is the one value actually sent to the
 * backend, and it is the only thing that tells two otherwise identical cards
 * apart at the point of no return.
 */
@customElement("confirm-dialog")
export class ConfirmDialog extends DialogBase {
  static styles = [
    DialogBase.styles,
    css`
      .dialog-message {
        margin: 0 0 1rem 0;
      }

      .drive-name {
        font-weight: 600;
      }

      .drive-details {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.375rem 1rem;
        padding: 0.75rem 1rem;
        margin: 0 0 1rem 0;
        background-color: var(--ha-card-background, #ffffff);
        border: 1px solid var(--ha-border-color, #e0e0e0);
        border-radius: var(--ha-small-border-radius, 8px);
        font-size: 0.875rem;
      }

      .detail-label {
        color: var(--ha-secondary-text-color, #727272);
        margin: 0;
      }

      .detail-value {
        color: var(--ha-text-color, #212121);
        margin: 0;
        font-weight: 500;
        overflow-wrap: anywhere;
      }

      .detail-value.path {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }

      .password-note {
        font-size: 0.875rem;
        color: var(--ha-secondary-text-color, #727272);
        line-height: 1.5;
        margin: 0;
      }
    `,
  ];

  @property({ type: String, attribute: "drive-name" })
  driveName = "";

  /** Device id/path handed to the backend, e.g. "/dev/sda" or "disk2". */
  @property({ type: String, attribute: "drive-path" })
  drivePath = "";

  @property({ type: String, attribute: "drive-model" })
  driveModel = "";

  /** Size in bytes; undefined when unknown. */
  @property({ type: Number, attribute: "drive-size" })
  driveSize?: number;

  protected readonly dismissEvent = "dialog-cancel";

  protected renderContent() {
    return html`
      ${this.renderTitle(
        localize("components.confirm_dialog.erase_drive_and_install"),
        "warning"
      )}

      <p class="dialog-message">
        ${this.driveName
          ? localizeContent("components.confirm_dialog.erase_warning", {
              drive: html`<span class="drive-name">${this.driveName}</span>`,
            })
          : localize("components.confirm_dialog.erase_warning_unknown")}
      </p>

      ${this._renderDriveDetails()}
      ${this._promptsForPassword()
        ? html`<p class="password-note">
            ${localize("components.confirm_dialog.password_notice")}
          </p>`
        : ""}

      <wa-button slot="footer" appearance="outlined" @click=${this._onCancel}>
        ${localize("common.cancel")}
      </wa-button>
      <wa-button
        slot="footer"
        variant="danger"
        appearance="accent"
        @click=${this._onConfirm}
      >
        ${localize("components.confirm_dialog.erase_and_install")}
      </wa-button>
    `;
  }

  private _renderDriveDetails() {
    if (!this.drivePath && !this.driveModel && this.driveSize === undefined) {
      return nothing;
    }

    return html`
      <dl class="drive-details">
        ${this.drivePath
          ? html`
              <dt class="detail-label">${localize("common.device")}</dt>
              <dd class="detail-value path"><bdi>${this.drivePath}</bdi></dd>
            `
          : nothing}
        ${this.driveModel
          ? html`
              <dt class="detail-label">
                ${localize("components.confirm_dialog.model")}
              </dt>
              <dd class="detail-value">${this.driveModel}</dd>
            `
          : nothing}
        ${this.driveSize !== undefined
          ? html`
              <dt class="detail-label">
                ${localize("components.confirm_dialog.size")}
              </dt>
              <dd class="detail-value">${formatBytes(this.driveSize)}</dd>
            `
          : nothing}
      </dl>
    `;
  }

  private _onCancel() {
    this.choose("dialog-cancel");
  }

  private _onConfirm() {
    this.choose("dialog-confirm");
  }

  // macOS asks for admin credentials via Authorization Services; Linux raises
  // a polkit prompt through udisks2. Windows requires launching elevated, so
  // there is no in-flow prompt to announce.
  private _promptsForPassword(): boolean {
    const platform = getPlatform();
    return platform === "macos" || platform === "linux";
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "confirm-dialog": ConfirmDialog;
  }
}
