import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css, nothing } from "lit";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { logFrontendError } from "../../utils/diagnostics.js";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { formatBytes, getHaosRelease } from "../../api/commands.js";
import { selectedWifi } from "../../utils/wifi.js";
import { renderDriveIcon } from "../../components/drive-icon.js";
import {
  findInstaller,
  installerName,
  type HaHardwareInstaller,
} from "../ha-hardware/hardware.js";
import "../../components/inline-notice.js";

@customElement("confirmation-view")
export class ConfirmationView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100%;
    }

    h2 {
      font-size: 1.5rem;
      font-weight: 400;
      color: var(--ha-text-color, #212121);
      margin: 0 0 0.5rem 0;
      text-align: center;
    }

    .subtitle {
      font-size: 1rem;
      color: var(--ha-secondary-text-color, #727272);
      margin: 0 0 1.5rem 0;
      text-align: center;
    }

    .summary-card {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      padding: 1.5rem;
      background-color: var(--ha-card-background, #ffffff);
      border: 1px solid var(--ha-border-color, #e0e0e0);
      border-radius: 12px;
      width: 100%;
      box-sizing: border-box;
      max-width: 500px;
    }

    .summary-row {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .icon-container {
      width: 64px;
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

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

    .icon-container svg {
      width: 36px;
      height: 36px;
      fill: var(--ha-secondary-text-color, #727272);
    }

    .icon-container .ha-icon {
      fill: var(--ha-primary-color, #03a9f4);
    }

    .summary-info {
      flex: 1;
      min-width: 0;
    }

    .summary-label {
      font-size: 0.75rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--ha-secondary-text-color, #727272);
      margin: 0 0 0.25rem 0;
    }

    .summary-value {
      font-size: 1rem;
      font-weight: 500;
      color: var(--ha-text-color, #212121);
      margin: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .summary-detail {
      font-size: 0.875rem;
      color: var(--ha-secondary-text-color, #727272);
      margin: 0.25rem 0 0 0;
    }

    .drive-path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
    }

    inline-notice {
      margin-top: 1.5rem;
    }

    .divider {
      height: 1px;
      background-color: var(--ha-border-color, #e0e0e0);
      margin: 0;
    }
  `;

  @state()
  private _wizardState: WizardState = wizardState.getState();

  @state()
  private _haosVersion: string | null = "";

  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = wizardState.subscribe((state) => {
      this._wizardState = state;
    });
    void this._loadHaosVersion();
  }

  private async _loadHaosVersion() {
    const board = this._wizardState.selections.deviceConfig?.board;
    // An installer is pinned and named by date; it has no release to show.
    if (findInstaller(board)) return;

    try {
      if (!board) throw new Error("No board selected");
      const release = await getHaosRelease(undefined, board);
      this._haosVersion = release.version;
    } catch (error) {
      logFrontendError(error);
      this._haosVersion = null;
    }
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
      <h2>
        ${localize("views.proxmox.proxmox_confirm_view.ready_to_install")}
      </h2>
      <p class="subtitle">
        ${localize(
          "views.sbc.confirmation_view.review_your_selections_before_installing"
        )}
      </p>

      <div class="summary-card">
        <!-- Device -->
        <div class="summary-row">
          <div class="icon-container">
            ${deviceImage
              ? html`<img
                  class=${deviceImage.endsWith(".svg")
                    ? "device-icon"
                    : "device-image"}
                  src=${deviceImage}
                  alt=${deviceName}
                />`
              : html`<div class="device-image-placeholder">
                  ${this._renderBoardIcon()}
                </div>`}
          </div>
          <div class="summary-info">
            <p class="summary-label">
              ${localize("components.confirm_dialog.device")}
            </p>
            <p class="summary-value">${deviceName}</p>
            ${deviceConfig && !installer
              ? html`<p class="summary-detail">
                  ${localizeContent(
                    "views.sbc.confirmation_view.board_summary",
                    {
                      board: deviceConfig.board,
                    }
                  )}
                </p>`
              : ""}
          </div>
        </div>

        <div class="divider"></div>

        <!-- Drive -->
        <div class="summary-row">
          <div class="icon-container">
            ${renderDriveIcon(selections.driveType ?? "unknown")}
          </div>
          <div class="summary-info">
            <p class="summary-label">
              ${localize("views.sbc.confirmation_view.target_drive")}
            </p>
            <p class="summary-value">${driveName}</p>
            <p class="summary-detail">
              ${this._formatSize(driveSize)}${driveModel
                ? ` · ${driveModel}`
                : nothing}
            </p>
            ${drivePath
              ? html`<p class="summary-detail drive-path">${drivePath}</p>`
              : nothing}
          </div>
        </div>

        <div class="divider"></div>

        ${installer ? this._renderInstaller(installer) : this._renderHaos()}
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

  private _renderHaos() {
    return html`
      <div class="summary-row">
        <div class="icon-container">${this._renderHaIcon()}</div>
        <div class="summary-info">
          <p class="summary-label">
            ${localize(
              "views.proxmox.proxmox_confirm_view.home_assistant_operating_system"
            )}
          </p>
          <p class="summary-value">
            ${this._haosVersion === null
              ? localize("common.version_unknown")
              : this._haosVersion
                ? localize(
                    "views.proxmox.proxmox_confirm_view.version_summary",
                    {
                      version: this._haosVersion,
                    }
                  )
                : localize("common.loading")}
          </p>
          <p class="summary-detail">
            ${localize(
              "views.proxmox.proxmox_confirm_view.latest_stable_release"
            )}
          </p>
        </div>
      </div>
    `;
  }

  private _renderInstaller(installer: HaHardwareInstaller) {
    return html`
      <div class="summary-row">
        <div class="icon-container">${this._renderHaIcon()}</div>
        <div class="summary-info">
          <p class="summary-label">
            ${localize("views.sbc.confirmation_view.installer")}
          </p>
          <p class="summary-value">${installerName(installer)}</p>
          <p class="summary-detail">
            ${localize("views.sbc.confirmation_view.installer_detail")}
          </p>
        </div>
      </div>
    `;
  }

  private _renderWifi(network: string) {
    return html`
      <div class="divider"></div>
      <div class="summary-row">
        <div class="icon-container">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M12,21L15.6,16.2C14.6,15.45 13.35,15 12,15C10.65,15 9.4,15.45 8.4,16.2L12,21M12,3C7.95,3 4.21,4.34 1.2,6.6L3,9C5.5,7.12 8.62,6 12,6C15.38,6 18.5,7.12 21,9L22.8,6.6C19.79,4.34 16.05,3 12,3M12,9C9.3,9 6.81,9.89 4.8,11.4L6.6,13.8C8.1,12.67 9.97,12 12,12C14.03,12 15.9,12.67 17.4,13.8L19.2,11.4C17.19,9.89 14.7,9 12,9Z"
            />
          </svg>
        </div>
        <div class="summary-info">
          <p class="summary-label">
            ${localize("views.sbc.confirmation_view.wifi")}
          </p>
          <p class="summary-value">${network}</p>
        </div>
      </div>
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
    if (bytes === undefined)
      return localize("views.sbc.confirmation_view.unknown_size");
    return formatBytes(bytes);
  }

  private _renderBoardIcon() {
    return html`
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M6 2C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V4C20 2.9 19.1 2 18 2H6ZM6 4H18V20H6V4ZM8 6V8H10V6H8ZM14 6V8H16V6H14ZM11 10V12H13V10H11ZM8 14V16H10V14H8ZM14 14V16H16V14H14Z"
        />
      </svg>
    `;
  }

  private _renderHaIcon() {
    // Home Assistant icon from the official logo
    return html`
      <svg
        class="ha-icon"
        viewBox="0 0 240 240"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M229.39 109.203L130.61 10.423C124.78 4.59304 115.23 4.59304 109.4 10.423L10.61 109.203C4.78 115.033 0 126.563 0 134.813V224.813C0 233.063 6.75 239.813 15 239.813H107.27L66.64 199.183C64.55 199.903 62.32 200.313 60 200.313C48.7 200.313 39.5 191.113 39.5 179.813C39.5 168.513 48.7 159.313 60 159.313C71.3 159.313 80.5 168.513 80.5 179.813C80.5 182.143 80.09 184.373 79.37 186.463L111 218.093V102.213C104.2 98.873 99.5 91.893 99.5 83.823C99.5 72.523 108.7 63.323 120 63.323C131.3 63.323 140.5 72.523 140.5 83.823C140.5 91.893 135.8 98.873 129 102.213V183.483L160.46 152.023C159.84 150.063 159.5 147.983 159.5 145.823C159.5 134.523 168.7 125.323 180 125.323C191.3 125.323 200.5 134.523 200.5 145.823C200.5 157.123 191.3 166.323 180 166.323C177.5 166.323 175.12 165.853 172.91 165.033L129 208.943V239.823H225C233.25 239.823 240 233.073 240 224.823V134.823C240 126.573 235.23 115.053 229.39 109.213V109.203Z"
        />
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "confirmation-view": ConfirmationView;
  }
}
