import { localize, localizeContent } from "../../localization/localize.js";
import {
  installerError,
  renderErrorHelp,
  type InstallerError,
} from "../../utils/installer-error.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { InstallDiagnostics } from "../../utils/diagnostics.js";
import { customElement, state } from "lit/decorators.js";
import {
  formatBytes,
  listBlockDevices,
  type BlockDevice,
} from "../../api/index.js";
import { wizardState } from "../../state/wizard-state.js";
import {
  clearDriveSelection,
  findDrive,
  getDriveFit,
  isEligibleFlashTarget,
  readDriveSelection,
  storeDriveSelection,
} from "../../utils/drive-selection.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import "../../components/drive-card.js";
import "../../components/casita-mascot.js";

@customElement("drive-selection-view")
export class DriveSelectionView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = css`
    ${reducedMotionStyles}
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
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

    .warning {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 1rem;
      background-color: rgba(255, 152, 0, 0.1);
      border: 1px solid rgba(255, 152, 0, 0.3);
      border-radius: 8px;
      margin-bottom: 1.5rem;
      max-width: 500px;
      width: 100%;
    }

    .warning-icon {
      font-size: 1.25rem;
      flex-shrink: 0;
    }

    .warning-text {
      font-size: 0.875rem;
      color: var(--ha-text-color, #212121);
      margin: 0;
      line-height: 1.5;
    }

    @media (prefers-color-scheme: dark) {
      .warning {
        background-color: rgba(255, 152, 0, 0.15);
        border-color: rgba(255, 152, 0, 0.4);
      }
    }

    .notice {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 1rem;
      background-color: rgba(219, 68, 55, 0.1);
      border: 1px solid rgba(219, 68, 55, 0.3);
      border-radius: 8px;
      margin-bottom: 1.5rem;
      max-width: 500px;
      width: 100%;
    }

    .notice-icon {
      font-size: 1.25rem;
      flex-shrink: 0;
    }

    .notice-text {
      font-size: 0.875rem;
      color: var(--ha-text-color, #212121);
      margin: 0;
      line-height: 1.5;
    }

    @media (prefers-color-scheme: dark) {
      .notice {
        background-color: rgba(219, 68, 55, 0.15);
        border-color: rgba(219, 68, 55, 0.4);
      }
    }

    .drives-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      max-width: 500px;
      margin-bottom: 1rem;
    }

    .drives-title {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--ha-secondary-text-color, #727272);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin: 0;
    }

    .drives-list {
      width: 100%;
      max-width: 500px;
    }

    .drives-list::part(form-control-input) {
      gap: 0.75rem;
    }

    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 3rem;
      color: var(--ha-secondary-text-color, #727272);
    }

    .loading-spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--ha-border-color, #e0e0e0);
      border-top-color: var(--ha-primary-color, #03a9f4);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 1rem;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .error {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem;
      text-align: center;
    }

    .error-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
    }

    .error-message {
      color: var(--ha-error-color, #db4437);
      margin-bottom: 1rem;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem;
      text-align: center;
      color: var(--ha-secondary-text-color, #727272);
    }

    casita-mascot {
      margin-bottom: 1rem;
    }

    .empty-title {
      font-size: 1.125rem;
      font-weight: 500;
      color: var(--ha-text-color, #212121);
      margin: 0 0 0.5rem 0;
    }

    .empty-text {
      font-size: 0.875rem;
      margin: 0;
    }
  `;

  @state()
  private _drives: BlockDevice[] = [];

  @state()
  private _loading = true;

  @state()
  private _error: InstallerError | null = null;

  @state()
  private _selectedDriveId: string | null = null;

  /** Set when a previously selected drive was dropped by a re-scan. */
  @state()
  private _selectionLost = false;

  connectedCallback() {
    super.connectedCallback();

    // Restore an earlier selection; _loadDrives() then confirms it is still
    // the same device and drops it if it is not.
    this._selectedDriveId = wizardState.getState().selections.drive ?? null;

    void this._loadDrives();
  }

  private async _loadDrives() {
    this._loading = true;
    this._error = null;

    let drives: BlockDevice[];
    let error: InstallerError | null = null;
    let scanError: unknown;
    try {
      drives = (await listBlockDevices()).filter((drive) => drive.removable);
    } catch (err) {
      scanError = err;
      error = installerError(
        err,
        localize("views.sbc.drive_selection_view.failed_to_load_drives")
      );
      // The scan failed, so the selection cannot be confirmed. Drop it rather
      // than let a stale path through to the write.
      drives = [];
    }

    // The user left this step while the scan ran. The wizard state may now
    // belong to a new flow, so this result must not touch it.
    if (!this.isConnected) {
      return;
    }

    this._drives = drives;
    this._error = error;
    if (error) new InstallDiagnostics("flash").fail(scanError);
    this._loading = false;
    this._reconcileSelection();
  }

  /**
   * Drop the stored selection unless the exact same device is still in the
   * freshly enumerated list. Device ids are reused: unplugging the selected
   * stick and plugging in another one can hand the new device the same path,
   * and without this the wizard would carry that path to the erase.
   */
  private _reconcileSelection() {
    const selection = readDriveSelection(wizardState.getState().selections);
    if (!selection) {
      this._selectedDriveId = null;
      return;
    }

    if (
      findDrive(
        this._drives,
        selection,
        wizardState.getState().selections.deviceConfig
      )
    ) {
      this._selectedDriveId = selection.id;
      this._selectionLost = false;
      return;
    }

    clearDriveSelection();
    this._selectedDriveId = null;
    this._selectionLost = true;
  }

  private _isMiniPCFlow(): boolean {
    return wizardState.getState().currentFlow === "minipc";
  }

  render() {
    const isMiniPC = this._isMiniPCFlow();
    const subtitle = isMiniPC
      ? localize(
          "views.sbc.drive_selection_view.choose_the_nvme_ssd_drive_to_install_home_assistant_on"
        )
      : localize(
          "views.sbc.drive_selection_view.choose_the_sd_card_or_usb_drive_to_install_home_assistant_on"
        );

    return html`
      <h2>${localize("views.sbc.drive_selection_view.select_your_drive")}</h2>
      <p class="subtitle">${subtitle}</p>

      <div class="warning">
        <span class="warning-icon">⚠️</span>
        <p class="warning-text">
          ${localizeContent(
            "views.sbc.drive_selection_view.value_all_data_on_the_selected_drive_will_be_permanently_erased_make_sure_y",
            {
              value0: html`<strong
                >${localize("views.sbc.drive_selection_view.warning")}</strong
              >`,
            }
          )}
        </p>
      </div>

      <!-- The live region stays in the DOM so that inserting the notice into
           it is announced; a region added together with its content often
           is not. -->
      <div class="notice-region" role="status">
        ${this._selectionLost
          ? html`
              <div class="notice">
                <span class="notice-icon" aria-hidden="true">🔌</span>
                <p class="notice-text">
                  ${localize(
                    "views.sbc.drive_selection_view.the_drive_you_selected_is_no_longer_available_so_the_selection_was_cleared_"
                  )}
                </p>
              </div>
            `
          : ""}
      </div>
      ${this._renderContent()}
    `;
  }

  private _renderContent() {
    const config = wizardState.getState().selections.deviceConfig;
    // Full-page spinner only on the initial scan (nothing to show yet).
    // A refresh with drives already listed keeps the list visible and shows
    // the loading state on the refresh button instead.
    if (this._loading && this._drives.length === 0) {
      return html`
        <div class="loading">
          <div class="loading-spinner"></div>
          <span
            >${localize(
              "views.sbc.drive_selection_view.scanning_for_drives"
            )}</span
          >
        </div>
      `;
    }

    if (this._error) {
      return html`
        <div class="error">
          <span class="error-icon">⚠️</span>
          <p
            class="error-message"
            role="alert"
            style="overflow-wrap: anywhere;"
          >
            ${this._error?.message}
          </p>
          ${renderErrorHelp()}
          ${this._error.retryable
            ? html`<wa-button
                variant="brand"
                appearance="outlined"
                @click=${this._loadDrives}
              >
                ${localize("components.app_shell.try_again")}
              </wa-button>`
            : ""}
        </div>
      `;
    }

    if (this._drives.length === 0) {
      const emptyTitle = localize(
        "views.sbc.drive_selection_view.no_drives_found"
      );
      const emptyText = this._isMiniPCFlow()
        ? localize(
            "views.sbc.drive_selection_view.connect_your_drive_using_a_usb_adapter_and_select_refresh"
          )
        : localize(
            "views.sbc.drive_selection_view.insert_an_sd_card_or_usb_drive_and_select_refresh"
          );

      return html`
        <div class="empty-state">
          <casita-mascot mood="sad"></casita-mascot>
          <p class="empty-title">${emptyTitle}</p>
          <p class="empty-text">${emptyText}</p>
          <wa-button
            variant="brand"
            appearance="outlined"
            @click=${this._loadDrives}
            style="margin-top: 1rem;"
          >
            <span slot="start">↻</span> ${localize("common.refresh")}
          </wa-button>
        </div>
      `;
    }

    return html`
      <div class="drives-header">
        <p class="drives-title">
          ${localize("views.sbc.drive_selection_view.available_drives")}
        </p>
        <wa-button
          variant="brand"
          appearance="outlined"
          @click=${this._loadDrives}
          ?loading=${this._loading}
        >
          <span slot="start">↻</span> ${localize("common.refresh")}
        </wa-button>
      </div>

      <wa-radio-group
        class="drives-list"
        radio-tag="drive-card"
        aria-label=${localize("views.sbc.confirmation_view.target_drive")}
        .value=${this._selectedDriveId ?? ""}
        @change=${this._onDriveChange}
      >
        ${[...this._drives]
          .sort((a, b) => {
            const aTooSmall = !isEligibleFlashTarget(a, config);
            const bTooSmall = !isEligibleFlashTarget(b, config);
            // Sort selectable drives first, then by size descending
            if (aTooSmall !== bTooSmall) return aTooSmall ? 1 : -1;
            return b.size - a.size;
          })
          .map((drive) => {
            const fit = getDriveFit(drive.size, config);
            const disabled = !isEligibleFlashTarget(drive, config);
            const reason =
              fit === "too-small"
                ? localize(
                    "views.sbc.drive_selection_view.minimum_value_drive_required",
                    { value0: formatBytes(config!.minimum_storage_bytes) }
                  )
                : fit === "unavailable"
                  ? localize(
                      "views.sbc.drive_selection_view.drive_capacity_or_board_requirements_unavailable"
                    )
                  : "";

            return html`
              <drive-card
                .value=${drive.id}
                .name=${drive.name}
                .driveSize=${drive.size}
                .deviceType=${drive.device_type}
                .model=${drive.model || ""}
                .vendor=${drive.vendor || ""}
                .disabled=${disabled}
                .disabledReason=${reason}
                .capacityWarning=${fit === "below-recommended"
                  ? localize(
                      "views.sbc.drive_selection_view.a_value_drive_is_recommended_space_for_apps_history_and_backups_will_be_lim",
                      { value0: formatBytes(config!.recommended_storage_bytes) }
                    )
                  : ""}
              ></drive-card>
            `;
          })}
      </wa-radio-group>
    `;
  }

  private _onDriveChange(e: Event) {
    const id = (e.target as { value?: string | number | null }).value;
    const drive = this._drives.find((d) => d.id === id);
    if (
      drive &&
      isEligibleFlashTarget(
        drive,
        wizardState.getState().selections.deviceConfig
      )
    ) {
      this._onSelectDrive(drive);
    }
  }

  private _onSelectDrive(drive: BlockDevice) {
    this._selectedDriveId = drive.id;
    this._selectionLost = false;
    storeDriveSelection(drive);

    this.dispatchEvent(
      new CustomEvent("drive-selected", {
        detail: { drive },
        bubbles: true,
        composed: true,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "drive-selection-view": DriveSelectionView;
  }
}
