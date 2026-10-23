import { localize } from "../../localization/localize.js";
import {
  installerError,
  type InstallerError,
} from "../../utils/installer-error.js";
import { linkStyles } from "../../utils/link-styles.js";
import { sectionLabelStyles } from "../../utils/section-label-styles.js";
import { LitElement, html, css } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  ViewAccessibility,
  activeElement,
  focusHeading,
  reducedMotionStyles,
  srOnlyStyles,
} from "../../utils/view-accessibility.js";
import { InstallDiagnostics } from "../../utils/diagnostics.js";
import { customElement, query, state } from "lit/decorators.js";
import {
  formatBytes,
  listBlockDevices,
  type BlockDevice,
  type HaosConfig,
} from "../../api/index.js";
import { wizardState } from "../../state/wizard-state.js";
import {
  clearDriveSelection,
  driveIdentity,
  findDrive,
  getDriveFit,
  isEligibleFlashTarget,
  isSameDrive,
  readDriveSelection,
  storeDriveSelection,
} from "../../utils/drive-selection.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import "../../components/drive-card.js";
import "../../components/casita-mascot.js";
import "../../components/inline-notice.js";
import "../ha-hardware/connect-instructions.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";
import {
  loadStateStyles,
  renderLoadError,
  renderLoading,
} from "../../utils/load-state.js";

@customElement("drive-selection-view")
export class DriveSelectionView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    loadStateStyles,
    srOnlyStyles,
    reducedMotionStyles,
    linkStyles,
    sectionLabelStyles,
    css`
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

      .drives-list {
        width: 100%;
        max-width: 500px;
      }

      /* Named by its label, which the heading above already shows. */
      .drives-list::part(form-control-label) {
        display: none;
      }

      .drives-list::part(form-control-input) {
        gap: 0.75rem;
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

  /** Why no drive can be picked, while none can */
  @query(".no-usable-drive")
  private _noUsableDriveReason?: HTMLElement;

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
    // Next waits until this scan has confirmed the selection
    if (wizardState.getState().selections.driveScanReady) {
      wizardState.setSelection("driveScanReady", false);
    }

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
      drives = [];
    }

    // The user left this step while the scan ran. The wizard state may now
    // belong to a new flow, so this result must not touch it.
    if (!this.isConnected) {
      return;
    }

    const explained = this._noUsableDrive();
    this._drives = drives;
    this._error = error;
    if (error) new InstallDiagnostics("flash").fail(scanError);
    this._loading = false;
    this._scanned = true;
    this._reconcileSelection();
    // A failed scan confirmed nothing, so Next keeps waiting for one that does
    if (!error) wizardState.setSelection("driveScanReady", true);

    await this.updateComplete;
    // Not one card can be picked, so the group takes no focus and Tab skips
    // every drive. Continue from why instead, when that is new.
    const why = this._noUsableDriveReason;
    const active = activeElement();
    if (
      why &&
      !explained &&
      (!active || active === document.body || this.matches(":focus-within"))
    ) {
      focusHeading(why);
      return;
    }
    // Refresh can give way to the list it found, or the other way around
    this._accessibility.restoreFocus(this._refreshButton);
  }

  /** Whether the list is up, but every drive on it is disabled. */
  private _noUsableDrive(): boolean {
    const config = wizardState.getState().selections.deviceConfig;
    return (
      this._scanned &&
      !this._error &&
      this._drives.length > 0 &&
      !this._drives.some((drive) => isEligibleFlashTarget(drive, config))
    );
  }

  /** What the last scan found, once there is a list to refresh. */
  private _scanStatus(): string {
    if (!this._scanned) return "";
    if (this._loading) {
      return localize("views.sbc.drive_selection_view.scanning_for_drives");
    }
    if (this._error) return "";
    const count = this._drives.length;
    if (!count) {
      return localize("views.sbc.drive_selection_view.no_drives_found");
    }
    const config = wizardState.getState().selections.deviceConfig;
    const usable = this._drives.filter((drive) =>
      isEligibleFlashTarget(drive, config)
    ).length;
    if (usable === count) {
      return localize("views.sbc.drive_selection_view.drives_found", {
        count,
      });
    }
    return usable
      ? localize("views.sbc.drive_selection_view.drives_found_usable", {
          count,
          usable,
        })
      : localize("views.sbc.drive_selection_view.drives_found_none_usable", {
          count,
        });
  }

  /**
   * Drop the stored selection unless the exact same device is still in the
   * freshly enumerated list. Device ids are reused: unplugging the selected
   * stick and plugging in another one can hand the new device the same path,
   * and without this the wizard would carry that path to the erase.
   */
  private _reconcileSelection() {
    // The install dropped a drive it couldn't confirm and sent the user back.
    // Said only now, into the live region already in place, so it is announced.
    if (wizardState.getState().selections.driveSelectionLost) {
      wizardState.setSelection("driveSelectionLost", undefined);
      this._selectionLost = true;
    }

    // A failed scan can't tell whether the drive is still there. Its
    // selection stays, and only a scan that no longer finds the drive clears
    // it, and says so.
    if (this._error) return;

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
    // A drive still listed only falls short of this board, which its card says
    const listed = this._drives.some((drive) =>
      isSameDrive(selection, driveIdentity(drive))
    );
    if (!listed) this._selectionLost = true;
  }

  private _isMiniPCFlow(): boolean {
    return wizardState.getState().currentFlow === "minipc";
  }

  private _isHaHardwareFlow(): boolean {
    return wizardState.getState().currentFlow === "ha-hardware";
  }

  private _subtitle(): string {
    if (wizardState.getState().selections.installMethod === "usb-boot") {
      return localize("views.sbc.drive_selection_view.choose_the_usb_stick");
    }
    if (this._isMiniPCFlow()) {
      return localize("views.sbc.drive_selection_view.subtitle_nvme");
    }
    if (this._isHaHardwareFlow()) {
      return localize("views.sbc.drive_selection_view.subtitle_device_storage");
    }
    return localize("views.sbc.drive_selection_view.subtitle_removable");
  }

  render() {
    return html`
      ${renderStepHeading(
        localize("views.sbc.drive_selection_view.select_your_drive"),
        this._subtitle()
      )}
      ${this._isHaHardwareFlow()
        ? html`<ha-hardware-connect-instructions
            .hardware=${wizardState.getState().selections.haHardware}
          ></ha-hardware-connect-instructions>`
        : ""}

      <!-- The live region stays in the DOM so that inserting the notice into
           it is announced; a region added together with its content often
           is not. -->
      <div class="notice-region" role="status">
        ${this._selectionLost
          ? html`
              <inline-notice variant="error" icon="🔌">
                <p>
                  ${localize(
                    "views.sbc.drive_selection_view.selection_cleared"
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
      return renderLoading(
        localize("views.sbc.drive_selection_view.scanning_for_drives")
      );
    }

    if (this._error) {
      return renderLoadError(this._error, this._loading, () =>
        this._loadDrives()
      );
    }

    if (this._drives.length === 0) {
      const emptyTitle = localize(
        "views.sbc.drive_selection_view.no_drives_found"
      );
      const emptyText = this._isMiniPCFlow()
        ? localize("views.sbc.drive_selection_view.no_drives_adapter")
        : this._isHaHardwareFlow()
          ? localize("views.sbc.drive_selection_view.no_drives_described_above")
          : localize("views.sbc.drive_selection_view.no_drives_removable");

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
            <span slot="start" aria-hidden="true">↻</span>
            ${localize("common.refresh")}
          </wa-button>
        </div>
      `;
    }

    return html`
      ${this._noUsableDrive() ? this._renderNoUsableDrive(config) : ""}
      <div class="drives-header">
        <h3 class="section-label">
          ${localize("views.sbc.drive_selection_view.available_drives")}
        </h3>
        <wa-button
          variant="brand"
          appearance="outlined"
          @click=${this._loadDrives}
          ?loading=${this._loading}
        >
          <span slot="start" aria-hidden="true">↻</span>
          ${localize("common.refresh")}
        </wa-button>
      </div>

      <wa-radio-group
        class="drives-list"
        radio-tag="drive-card"
        label=${localize("common.target_drive")}
        .value=${this._selectedDriveId ?? ""}
        @change=${this._onDriveChange}
      >
        ${repeat(
          [...this._drives].sort((a, b) => {
            const aTooSmall = !isEligibleFlashTarget(a, config);
            const bTooSmall = !isEligibleFlashTarget(b, config);
            // Sort selectable drives first, then by size descending
            if (aTooSmall !== bTooSmall) return aTooSmall ? 1 : -1;
            return b.size - a.size;
          }),
          // Keyed, so a card stays with its drive. The radio group only
          // re-syncs `checked` when its own value changes: reused by position,
          // a card would keep the check while showing a newly listed drive.
          (drive) => drive.id,
          (drive) => {
            const fit = getDriveFit(drive.size, config);
            const disabled = !isEligibleFlashTarget(drive, config);
            const reason =
              fit === "too-small"
                ? localize("views.sbc.drive_selection_view.minimum_size", {
                    size: formatBytes(config!.minimum_storage_bytes),
                  })
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
                      "views.sbc.drive_selection_view.recommended_size",
                      { size: formatBytes(config!.recommended_storage_bytes) }
                    )
                  : ""}
              ></drive-card>
            `;
          }
        )}
      </wa-radio-group>
    `;
  }

  /**
   * Why none of the drives can be picked. Each disabled card says why it
   * can't, but nothing would say that none can.
   */
  private _renderNoUsableDrive(config?: HaosConfig) {
    const count = this._drives.length;
    // Any other drive has a capacity, or a board minimum, that is unknown.
    // One drive too small is enough to know the minimum.
    const tooSmall = this._drives.filter(
      (drive) => getDriveFit(drive.size, config) === "too-small"
    ).length;
    const size = tooSmall ? formatBytes(config!.minimum_storage_bytes) : "";
    return html`
      <inline-notice>
        <p class="no-usable-drive">
          ${tooSmall === count
            ? localize(
                "views.sbc.drive_selection_view.no_usable_drive_minimum",
                { count, size }
              )
            : tooSmall
              ? localize(
                  "views.sbc.drive_selection_view.no_usable_drive_minimum_or_unknown",
                  { size }
                )
              : localize(
                  "views.sbc.drive_selection_view.no_usable_drive_unavailable",
                  { count }
                )}
        </p>
      </inline-notice>
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
