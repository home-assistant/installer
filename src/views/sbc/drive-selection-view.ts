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
  srOnlyStyles,
} from "../../utils/view-accessibility.js";
import { InstallDiagnostics } from "../../utils/diagnostics.js";
import { customElement, query, state } from "lit/decorators.js";
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
import "../../components/inline-notice.js";
import "../ha-hardware/connect-instructions.js";

@customElement("drive-selection-view")
export class DriveSelectionView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    srOnlyStyles,
    reducedMotionStyles,
    css`
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

      inline-notice {
        margin-bottom: 1.5rem;
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
    `,
  ];

  @state()
  private _drives: BlockDevice[] = [];

  @state()
  private _loading = true;

  /** A scan finished, so a new one keeps its result on screen meanwhile */
  @state()
  private _scanned = false;

  /** Whichever Refresh, or Try again, the current result offers */
  @query(".drives-header wa-button, .empty-state wa-button, .error wa-button")
  private _refreshButton?: HTMLElement;

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
    // The previous result, error included, stays until this one replaces it
    this._loading = true;

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
    this._scanned = true;
    this._reconcileSelection();

    // Refresh can give way to the list it found, or the other way around
    await this.updateComplete;
    this._accessibility.restoreFocus(this._refreshButton);
  }

  /** What the last scan found, once there is a list to refresh. */
  private _scanStatus(): string {
    if (!this._scanned) return "";
    if (this._loading) {
      return localize("views.sbc.drive_selection_view.scanning_for_drives");
    }
    if (this._error) return "";
    return this._drives.length
      ? localize("views.sbc.drive_selection_view.drives_found", {
          count: this._drives.length,
        })
      : localize("views.sbc.drive_selection_view.no_drives_found");
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

  private _isHaHardwareFlow(): boolean {
    return wizardState.getState().currentFlow === "ha-hardware";
  }

  private _subtitle(): string {
    if (this._isMiniPCFlow()) {
      return localize(
        "views.sbc.drive_selection_view.choose_the_nvme_ssd_drive_to_install_home_assistant_on"
      );
    }
    if (this._isHaHardwareFlow()) {
      return localize(
        "views.sbc.drive_selection_view.connect_your_device_storage_then_select_it"
      );
    }
    return localize(
      "views.sbc.drive_selection_view.choose_the_sd_card_or_usb_drive_to_install_home_assistant_on"
    );
  }

  render() {
    return html`
      <h2>${localize("views.sbc.drive_selection_view.select_your_drive")}</h2>
      <p class="subtitle">${this._subtitle()}</p>

      ${this._isHaHardwareFlow()
        ? html`<ha-hardware-connect-instructions
            .hardware=${wizardState.getState().selections.haHardware}
          ></ha-hardware-connect-instructions>`
        : ""}

      <inline-notice>
        <p>
          ${localizeContent(
            "views.sbc.drive_selection_view.value_all_data_on_the_selected_drive_will_be_permanently_erased_make_sure_y",
            {
              value0: html`<strong
                >${localize("views.sbc.drive_selection_view.warning")}</strong
              >`,
            }
          )}
        </p>
      </inline-notice>

      <!-- The live region stays in the DOM so that inserting the notice into
           it is announced; a region added together with its content often
           is not. -->
      <div class="notice-region" role="status">
        ${this._selectionLost
          ? html`
              <inline-notice variant="error" icon="🔌">
                <p>
                  ${localize(
                    "views.sbc.drive_selection_view.the_drive_you_selected_is_no_longer_available_so_the_selection_was_cleared_"
                  )}
                </p>
              </inline-notice>
            `
          : ""}
      </div>
      <p class="sr-only" role="status">${this._scanStatus()}</p>
      ${this._renderContent()}
    `;
  }

  private _renderContent() {
    const config = wizardState.getState().selections.deviceConfig;
    // Full-page spinner only on the initial scan (nothing to show yet).
    // A refresh keeps the list, the empty state or the error visible, and
    // shows the loading state on the button that started it, so the button
    // keeps focus.
    if (!this._scanned) {
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
          <!-- Empty while trying again, so the same failure is read out again -->
          <p
            class="error-message"
            role="alert"
            style="overflow-wrap: anywhere;"
          >
            ${this._loading ? "" : this._error?.message}
          </p>
          ${renderErrorHelp()}
          ${this._error.retryable
            ? html`<wa-button
                variant="brand"
                appearance="outlined"
                ?loading=${this._loading}
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
        : this._isHaHardwareFlow()
          ? localize(
              "views.sbc.drive_selection_view.connect_the_drive_as_described_above_and_select_refresh"
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
            ?loading=${this._loading}
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
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "drive-selection-view": DriveSelectionView;
  }
}
