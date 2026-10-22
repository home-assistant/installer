import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css, nothing } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { formatBytes, getHaosRelease } from "../../api/commands.js";
import { selectedWifi } from "../../utils/wifi.js";
import { renderDriveIcon } from "../../components/drive-icon.js";
import {
  HaosVersion,
  haIcon,
  renderHaosVersionRow,
  renderSummaryIcon,
  renderSummaryRow,
  summaryStyles,
} from "../../components/summary-card.js";
import {
  findInstaller,
  installerName,
  type HaHardwareInstaller,
} from "../ha-hardware/hardware.js";
import "../../components/inline-notice.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";

// A board, for a device without a picture
const boardIcon =
  "M6 2C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V4C20 2.9 19.1 2 18 2H6ZM6 4H18V20H6V4ZM8 6V8H10V6H8ZM14 6V8H16V6H14ZM11 10V12H13V10H11ZM8 14V16H10V14H8ZM14 14V16H16V14H14Z";

const mdiWifi =
  "M12,21L15.6,16.2C14.6,15.45 13.35,15 12,15C10.65,15 9.4,15.45 8.4,16.2L12,21M12,3C7.95,3 4.21,4.34 1.2,6.6L3,9C5.5,7.12 8.62,6 12,6C15.38,6 18.5,7.12 21,9L22.8,6.6C19.79,4.34 16.05,3 12,3M12,9C9.3,9 6.81,9.89 4.8,11.4L6.6,13.8C8.1,12.67 9.97,12 12,12C14.03,12 15.9,12.67 17.4,13.8L19.2,11.4C17.19,9.89 14.7,9 12,9Z";

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
        overflow-wrap: anywhere;
      }

      inline-notice {
        margin-top: 1.5rem;
      }
    `,
  ];

  @state()
  private _wizardState: WizardState = wizardState.getState();

  private readonly _haosVersion = new HaosVersion(this, () => {
    const board = this._wizardState.selections.deviceConfig?.board;
    // An installer is pinned and named by date; it has no release to show.
    if (findInstaller(board)) return undefined;
    if (!board) throw new Error("No board selected");
    return getHaosRelease(undefined, board);
  });

  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = wizardState.subscribe((state) => {
      this._wizardState = state;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

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
          deviceImage
            ? html`<img
                class=${deviceImage.endsWith(".svg")
                  ? "device-icon"
                  : "device-image"}
                src=${deviceImage}
                alt=${deviceName}
              />`
            : html`<div class="device-image-placeholder">
                ${renderSummaryIcon(boardIcon)}
              </div>`,
          localize("common.device"),
          deviceName,
          deviceConfig && !installer
            ? html`<p class="summary-detail">
                ${localizeContent("views.sbc.confirmation_view.board_summary", {
                  board: deviceConfig.board,
                })}
              </p>`
            : nothing
        )}

        <div class="divider"></div>

        <!-- Drive -->
        ${renderSummaryRow(
          renderDriveIcon(selections.driveType ?? "unknown"),
          localize("common.target_drive"),
          driveName,
          html`<p class="summary-detail">
              ${this._formatSize(driveSize)}${driveModel
                ? ` · ${driveModel}`
                : nothing}
            </p>
            ${drivePath
              ? html`<p class="summary-detail drive-path">${drivePath}</p>`
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
        renderSummaryIcon(mdiWifi),
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
