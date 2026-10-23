import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css, nothing } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { customElement } from "lit/decorators.js";
import type { WizardState } from "../../state/wizard-state.js";
import { WizardStateController } from "../../state/wizard-state-controller.js";
import { formatBytes, getHaosRelease } from "../../api/commands.js";
import { selectedWifi } from "../../utils/wifi.js";
import { renderDriveIcon } from "../../components/drive-icon.js";
import {
  HaosVersion,
  haIcon,
  renderHaosVersionRow,
  renderSummaryRow,
  summaryStyles,
} from "../../utils/summary-styles.js";
import {
  findInstaller,
  installerName,
  type HaHardwareInstaller,
} from "../../state/ha-hardware.js";
import "../../components/inline-notice.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";
import { mdiWifi } from "../../utils/icons.js";
import { renderIcon } from "../../utils/render-icon.js";

// A board, for a device without a picture
const boardIcon =
  "M6 2C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V4C20 2.9 19.1 2 18 2H6ZM6 4H18V20H6V4ZM8 6V8H10V6H8ZM14 6V8H16V6H14ZM11 10V12H13V10H11ZM8 14V16H10V14H8ZM14 14V16H16V14H14Z";

@customElement("confirmation-view")
export class ConfirmationView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    summaryStyles,
    css`
      .device-image {
        width: 64px;
        height: 64px;
        object-fit: contain;
      }

      .device-icon {
        width: 36px;
        height: 36px;
      }

      .device-image-placeholder {
        width: 64px;
        height: 64px;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: var(--ha-border-color, #e0e0e0);
        border-radius: 8px;
      }

      .drive-path {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }

      inline-notice {
        margin-top: 1.5rem;
      }
    `,
  ];

  private readonly _wizard = new WizardStateController(this);

  private get _wizardState(): WizardState {
    return this._wizard.state;
  }

  private readonly _haosVersion = new HaosVersion(this, () => {
    const board = this._wizardState.selections.deviceConfig?.board;
    // An installer is pinned and named by date; it has no release to show.
    if (findInstaller(board)) return undefined;
    if (!board) throw new Error("No board selected");
    return getHaosRelease(undefined, board);
  });

  render() {
    const selections = this._wizardState.selections;
    const deviceName =
      selections.deviceName || localize("common.unknown_device");
    const deviceImage = selections.deviceImage;
    const driveName = selections.driveName || localize("common.unknown_drive");
    const driveSize = selections.driveSize;
    // The path is what actually gets written to, so show it alongside the
    // friendly name: two identical cards are otherwise indistinguishable.
    const drivePath = selections.drive || "";
    const driveModel = [selections.driveVendor, selections.driveModel]
      .filter(Boolean)
      .join(" ");
    const deviceConfig = selections.deviceConfig;
    const installer = findInstaller(deviceConfig?.board);
    const wifi = selectedWifi(selections);

    return html`
      ${renderStepHeading(
        localize("common.confirm.ready_to_install"),
        localize("views.sbc.confirmation_view.subtitle")
      )}

      <div class="summary-card">
        <!-- Device -->
        ${renderSummaryRow(
          // The device's name is right next to its picture
          deviceImage
            ? html`<img
                class=${deviceImage.endsWith(".svg")
                  ? "device-icon"
                  : "device-image"}
                src=${deviceImage}
                alt=""
              />`
            : html`<div class="device-image-placeholder">
                ${renderIcon(boardIcon)}
              </div>`,
          localize("common.device"),
          deviceName
        )}

        <div class="divider"></div>

        <!-- Drive -->
        ${renderSummaryRow(
          renderDriveIcon(selections.driveType ?? "unknown"),
          localize("common.target_drive"),
          driveName,
          html`<p class="summary-detail">
              ${driveModel
                ? localizeContent(
                    "views.sbc.confirmation_view.drive_size_and_model",
                    {
                      size: this._formatSize(driveSize),
                      model: html`<bdi>${driveModel}</bdi>`,
                    }
                  )
                : this._formatSize(driveSize)}
            </p>
            ${drivePath
              ? html`<p class="summary-detail drive-path">
                  <bdi>${drivePath}</bdi>
                </p>`
              : nothing}`
        )}

        <div class="divider"></div>

        ${installer
          ? this._renderInstaller(installer)
          : renderHaosVersionRow(this._haosVersion.version)}
        ${wifi ? this._renderWifi(wifi.ssid) : nothing}
      </div>

      ${this._wizardState.currentFlow === "ha-hardware"
        ? this._renderNotice(
            installer
              ? localize("views.sbc.confirmation_view.installer_erase_notice", {
                  device: deviceName,
                })
              : localize("views.sbc.confirmation_view.emmc_erase_notice", {
                  device: deviceName,
                })
          )
        : nothing}
      ${drivePath && !selections.driveSerial
        ? this._renderNotice(
            localize("views.sbc.confirmation_view.no_serial_notice")
          )
        : nothing}
    `;
  }

  private _renderInstaller(installer: HaHardwareInstaller) {
    return renderSummaryRow(
      haIcon,
      localize("views.sbc.confirmation_view.installer"),
      installerName(installer),
      html`<p class="summary-detail">
        ${localize("views.sbc.confirmation_view.installer_detail")}
      </p>`
    );
  }

  private _renderWifi(network: string) {
    return html`
      <div class="divider"></div>
      ${renderSummaryRow(
        renderIcon(mdiWifi),
        localize("views.sbc.confirmation_view.wifi"),
        network
      )}
    `;
  }

  private _renderNotice(message: string) {
    return html`
      <inline-notice role="note">
        <p>${message}</p>
      </inline-notice>
    `;
  }

  private _formatSize(bytes: number | undefined): string {
    if (bytes === undefined) return localize("common.unknown_size");
    return formatBytes(bytes);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "confirmation-view": ConfirmationView;
  }
}
