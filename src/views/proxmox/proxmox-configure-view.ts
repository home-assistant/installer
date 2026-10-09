import {
  installerError,
  renderErrorHelp,
  type InstallerError,
} from "../../utils/installer-error.js";
import { formatNumber, localize } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { InstallDiagnostics } from "../../utils/diagnostics.js";
import { customElement, state } from "lit/decorators.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import "@home-assistant/webawesome/dist/components/input/input.js";
import type WaSlider from "@home-assistant/webawesome/dist/components/slider/slider.js";
import "@home-assistant/webawesome/dist/components/slider/slider.js";
import type WaSelect from "@home-assistant/webawesome/dist/components/select/select.js";
import "@home-assistant/webawesome/dist/components/select/select.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import {
  proxmoxListNodes,
  proxmoxListStorage,
  proxmoxListBridges,
  proxmoxGetNextVmId,
  formatBytes,
} from "../../api/commands.js";
import type {
  ProxmoxBridge,
  ProxmoxNode,
  ProxmoxStorage,
} from "../../api/types.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import {
  DEFAULT_CPU_CORES,
  DEFAULT_DISK_SIZE_GB,
  DEFAULT_MEMORY_MB,
  DEFAULT_PROXMOX_VM_ID,
  DEFAULT_PROXMOX_VM_NAME,
} from "../../state/vm-defaults.js";

/** Lookups report an expired session as its own code, answered with Reconnect */
const SESSION_EXPIRED = "proxmox_session_expired";

/**
 * A changed certificate needs the same answer: reconnecting shows the new
 * certificate to confirm, while retrying would keep hitting the old pin.
 */
const CERTIFICATE_CHANGED = "proxmox_certificate_changed";

function isSessionExpired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === SESSION_EXPIRED || error.code === CERTIFICATE_CHANGED)
  );
}

@customElement("proxmox-configure-view")
export class ProxmoxConfigureView extends LitElement {
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
      margin: 0 0 0.75rem 0;
      text-align: center;
    }

    .config-card {
      display: flex;
      flex-direction: column;
      gap: 1.75rem;
      padding: 1rem 1.25rem;
      background-color: var(--ha-card-background, #ffffff);
      border: 1px solid var(--ha-border-color, #e0e0e0);
      border-radius: 12px;
      width: 100%;
      max-width: 500px;
    }

    @media (prefers-color-scheme: dark) {
      .config-card {
        background-color: var(--ha-card-background, #1e1e1e);
        border-color: var(--ha-border-color, #333333);
      }
    }

    .setting-row {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
    }

    .setting-icon {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .setting-icon svg {
      width: 22px;
      height: 22px;
      fill: var(--ha-secondary-text-color, #727272);
    }

    .setting-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0.3125rem;
      min-width: 0;
    }

    wa-slider::part(label) {
      display: block;
    }

    .setting-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }

    .setting-label {
      font-size: 0.9375rem;
      font-weight: 500;
      color: var(--ha-text-color, #212121);
    }

    .setting-value {
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--ha-primary-color, #03a9f4);
      min-width: 70px;
      text-align: right;
    }

    .setting-description {
      font-size: 0.75rem;
      color: var(--ha-secondary-text-color, #9e9e9e);
      margin: 0;
      line-height: 1.3;
    }

    .loading-text {
      font-size: 0.875rem;
      color: var(--ha-secondary-text-color, #9e9e9e);
      font-style: italic;
    }

    .error-text {
      font-size: 0.875rem;
      color: var(--ha-error-color, #db4437);
    }
  `;

  @state()
  private _wizardState: WizardState = wizardState.getState();

  @state()
  private _nodes: ProxmoxNode[] = [];

  @state()
  private _storages: ProxmoxStorage[] = [];

  @state()
  private _loadingNodes = true;

  @state()
  private _loadingStorage = false;

  @state()
  private _error: InstallerError | null = null;

  @state()
  private _sessionExpired = false;

  @state()
  private _selectedNode = "";

  @state()
  private _selectedStorage = "";

  @state()
  private _vmId = DEFAULT_PROXMOX_VM_ID;

  @state()
  private _vmName = DEFAULT_PROXMOX_VM_NAME;

  @state()
  private _cpuCores = DEFAULT_CPU_CORES;

  @state()
  private _memoryMb = DEFAULT_MEMORY_MB;

  @state()
  private _diskSizeGb = DEFAULT_DISK_SIZE_GB;

  private _unsubscribe?: () => void;

  /**
   * Whether the VM ID was restored from the wizard state or typed by the user.
   * Either way the API's "next free ID" suggestion must not overwrite it.
   */
  private _vmIdChosen = false;

  /** Bumped per storage lookup, so only the latest one applies its result */
  private _storageLookup = 0;
  @state() private _bridges: ProxmoxBridge[] = [];
  @state() private _selectedBridge = "";
  /** Node whose bridge lookup last completed, so an empty list is real. */
  @state() private _bridgesNode = "";

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = wizardState.subscribe((state) => {
      this._wizardState = state;
    });
    this._restoreSelections();
    wizardState.setSelection("proxmoxBridgeReady", false);
    void this._loadNodes();
  }

  /**
   * Seed the form from what is already in the wizard state, so stepping back
   * to an earlier step and forward again keeps the user's settings. The
   * defaults above only apply on the first visit.
   */
  private _restoreSelections() {
    const selections = this._wizardState.selections;
    this._selectedNode = selections.proxmoxNode ?? "";
    this._selectedStorage = selections.proxmoxStorage ?? "";
    this._selectedBridge = selections.proxmoxBridge ?? "";
    this._vmName = selections.vmName ?? DEFAULT_PROXMOX_VM_NAME;
    this._cpuCores = selections.cpuCores ?? DEFAULT_CPU_CORES;
    this._memoryMb = selections.memoryMb ?? DEFAULT_MEMORY_MB;
    this._diskSizeGb = selections.diskSizeGb ?? DEFAULT_DISK_SIZE_GB;

    if (selections.proxmoxVmId !== undefined) {
      this._vmId = selections.proxmoxVmId;
      this._vmIdChosen = true;
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  private async _loadNodes() {
    this._loadingNodes = true;
    this._error = null;
    this._sessionExpired = false;
    // Preserve choices across reconnects, but block Next until revalidated.
    wizardState.setSelection("proxmoxConfigureReady", false);
    const session = this._wizardState.selections.proxmoxSession;
    const isCurrentSession = () =>
      this._wizardState.selections.proxmoxSession === session;

    if (!session) {
      this._setError({
        code: SESSION_EXPIRED,
        message: localize(
          "views.proxmox.proxmox_configure_view.connect_to_proxmox_to_continue"
        ),
        retryable: false,
        details: {},
      });
      this._loadingNodes = false;
      return;
    }

    this._loadingNodes = true;
    try {
      const results = await Promise.allSettled([
        proxmoxListNodes(session),
        proxmoxGetNextVmId(session),
      ]);

      // The user may have left this step while the lookups were in flight;
      // saving now would write over what the next step reads
      if (!this.isConnected || !isCurrentSession()) return;

      // An expired session must take precedence over an ordinary failure
      // from the other lookup, regardless of which one finishes first.
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        const expired = failures.find((result) =>
          isSessionExpired(result.reason)
        );
        throw (expired ?? failures[0]).reason;
      }
      const nodes = (results[0] as PromiseFulfilledResult<ProxmoxNode[]>).value;
      const nextVmId = (results[1] as PromiseFulfilledResult<number>).value;

      this._nodes = nodes.filter((n) => n.status === "online");

      // The next free VM ID is only a suggestion - never overwrite an ID the
      // user has already been shown and may have changed
      if (!this._vmIdChosen) {
        this._vmId = nextVmId;
        this._vmIdChosen = true;
      }

      // Keep a restored node as long as it is still online
      const nodeStillOnline = this._nodes.some(
        (n) => n.name === this._selectedNode
      );
      if (!nodeStillOnline) {
        this._selectedNode = this._nodes[0]?.name ?? "";
        this._selectedBridge = "";
        this._bridges = [];
      }

      if (this._selectedNode) {
        await this._loadStorage();
        // The storage lookup is another chance to have left this step
        if (!this.isConnected || !isCurrentSession()) return;
      }

      this._saveSelections();
    } catch (error) {
      if (!this.isConnected || !isCurrentSession()) return;
      this._setError(error);
    } finally {
      this._loadingNodes = false;
      if (this.isConnected && isCurrentSession()) this._saveSelections();
    }
  }

  private async _loadStorage() {
    if (!this._selectedNode) return;

    const session = this._wizardState.selections.proxmoxSession;

    if (!session) return;

    const node = this._selectedNode;
    // Switching nodes quickly can have lookups finish out of order, even two
    // for the same node; only the latest one may update the storage
    const lookup = ++this._storageLookup;
    const isLatest = () => lookup === this._storageLookup;
    const isCurrentSession = () =>
      this._wizardState.selections.proxmoxSession === session;

    this._loadingStorage = true;
    // A new lookup replaces the previous one's error; an expired session
    // never gets here, since it clears the session first
    this._error = null;
    this._sessionExpired = false;
    wizardState.setSelection("proxmoxConfigureReady", false);
    wizardState.setSelection("proxmoxBridgeReady", false);
    try {
      const [storageResult, bridgeResult] = await Promise.allSettled([
        proxmoxListStorage(session, node),
        proxmoxListBridges(session, node),
      ]);

      if (!this.isConnected || !isCurrentSession()) return;

      // An expired session must take precedence over an ordinary failure
      // from the other lookup, regardless of which one finishes first.
      const failures = [storageResult, bridgeResult].filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );
      const expired = failures.find((result) =>
        isSessionExpired(result.reason)
      );
      if (!isLatest()) {
        // Session expiry applies to every node, even from a superseded
        // lookup; the catch below handles it. Other failures belong to the
        // old selection.
        if (expired) throw expired.reason;
        return;
      }

      // Preserve usable storage even when network discovery fails, and the
      // other way around. A failed list keeps its choice for retry/reconnect;
      // readiness keeps it from being used until a lookup verifies it again.
      if (storageResult.status === "fulfilled") {
        // Filter to only show storage that supports VM images
        this._storages = storageResult.value.filter(
          (s) => s.active && s.content.includes("images")
        );

        // Keep the selected storage if this node still offers it, otherwise
        // fall back to the first one available
        const storageStillAvailable = this._storages.some(
          (s) => s.name === this._selectedStorage
        );
        if (!storageStillAvailable) {
          this._selectedStorage = this._storages[0]?.name ?? "";
        }
      } else {
        this._storages = [];
      }

      if (bridgeResult.status === "fulfilled") {
        this._bridges = bridgeResult.value;
        this._bridgesNode = node;
        if (
          !this._bridges.some((bridge) => bridge.name === this._selectedBridge)
        ) {
          this._selectedBridge =
            this._bridges.find((bridge) => bridge.name === "vmbr0")?.name ??
            this._bridges[0]?.name ??
            "";
        }
      } else {
        this._bridges = [];
      }

      if (failures.length) throw (expired ?? failures[0]).reason;

      this._saveSelections();
    } catch (error) {
      if (!this.isConnected || !isCurrentSession()) return;
      if (!isLatest()) {
        // Session expiry applies to every node, even if this lookup was
        // superseded. Ordinary failures still belong to the old selection.
        if (isSessionExpired(error)) {
          this._setError(error);
        }
        return;
      }
      // The lists were already updated above; keep the choices for
      // retry/reconnect while readiness prevents using them.
      this._saveSelections();
      this._setError(error);
    } finally {
      // A newer lookup is still running and owns the loading state
      if (isLatest()) {
        this._loadingStorage = false;
        if (this.isConnected && isCurrentSession()) this._saveSelections();
      }
    }
  }

  private _setError(error: unknown) {
    // Only reached for the current, connected lookup, so detached or
    // superseded lookups never add diagnostics
    new InstallDiagnostics("proxmox").fail(error);
    this._sessionExpired = isSessionExpired(error);
    this._error = installerError(
      error,
      localize(
        "views.proxmox.proxmox_configure_view.failed_to_load_proxmox_configuration"
      )
    );
    if (this._sessionExpired) {
      wizardState.setSelection("proxmoxSession", undefined);
      wizardState.setSelection("proxmoxConnected", false);
    }
    wizardState.setSelection("proxmoxConfigureReady", false);
  }

  private _retry() {
    if (this._loadingNodes || this._loadingStorage) return;
    void this._loadNodes();
  }

  private _reconnect() {
    wizardState.goToStep(0);
  }

  private _saveSelections() {
    wizardState.setSelection("proxmoxNode", this._selectedNode);
    wizardState.setSelection("proxmoxStorage", this._selectedStorage);
    wizardState.setSelection("proxmoxBridge", this._selectedBridge);
    wizardState.setSelection(
      "proxmoxBridgeReady",
      !this._loadingNodes &&
        !this._loadingStorage &&
        !this._error &&
        this._bridges.some((bridge) => bridge.name === this._selectedBridge)
    );
    wizardState.setSelection(
      "proxmoxConfigureReady",
      !this._loadingNodes && !this._loadingStorage && !this._error
    );
    // A failed initial lookup must not turn the fallback ID into a choice
    // that suppresses the next-free-ID suggestion after reconnecting.
    if (this._vmIdChosen) {
      wizardState.setSelection("proxmoxVmId", this._vmId);
    }
    wizardState.setSelection("vmName", this._vmName);
    wizardState.setSelection("cpuCores", this._cpuCores);
    wizardState.setSelection("memoryMb", this._memoryMb);
    wizardState.setSelection("diskSizeGb", this._diskSizeGb);
  }

  private async _onNodeChange(e: Event) {
    const select = e.target as WaSelect;
    this._selectedNode = select.value as string;
    this._selectedStorage = "";
    this._selectedBridge = "";
    this._bridges = [];
    this._bridgesNode = "";
    this._saveSelections();
    await this._loadStorage();
  }

  private _onBridgeChange(e: Event) {
    const select = e.target as WaSelect;
    this._selectedBridge = select.value as string;
    this._saveSelections();
  }

  private _onStorageChange(e: Event) {
    const select = e.target as WaSelect;
    this._selectedStorage = select.value as string;
    this._saveSelections();
  }

  private _onVmIdChange(e: Event) {
    const input = e.target as WaInput;
    this._vmId = parseInt(input.value ?? "", 10) || DEFAULT_PROXMOX_VM_ID;
    this._vmIdChosen = true;
    this._saveSelections();
  }

  private _onNameChange(e: Event) {
    const input = e.target as WaInput;
    // Proxmox VM names: alphanumeric, dash, underscore, period only
    // Replace spaces with dashes and remove invalid characters
    let name = (input.value ?? "")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "");
    // Max 63 characters
    name = name.slice(0, 63);
    this._vmName = name || DEFAULT_PROXMOX_VM_NAME;
    // Update input to show sanitized value
    input.value = this._vmName;
    this._saveSelections();
  }

  private _onCoresChange(e: Event) {
    const input = e.target as WaSlider;
    const index = input.value;
    const coreOptions = this._getCoreOptions();
    this._cpuCores = coreOptions[index] || DEFAULT_CPU_CORES;
    this._saveSelections();
  }

  private _onMemoryChange(e: Event) {
    const input = e.target as WaSlider;
    const index = input.value;
    const memoryOptions = this._getMemoryOptions();
    this._memoryMb = memoryOptions[index] || DEFAULT_MEMORY_MB;
    this._saveSelections();
  }

  private _onDiskSizeChange(e: Event) {
    const input = e.target as WaSlider;
    const index = input.value;
    const diskOptions = this._getDiskSizeOptions();
    this._diskSizeGb = diskOptions[index] || DEFAULT_DISK_SIZE_GB;
    this._saveSelections();
  }

  private _getCoreOptions(): number[] {
    return [2, 4, 6, 8, 10, 12, 16];
  }

  private _getMemoryOptions(): number[] {
    return [2048, 4096, 6144, 8192, 12288, 16384, 24576, 32768];
  }

  private _formatMemory(mb: number): string {
    const gb = mb / 1024;
    return localize("components.drive_card.value_gb", {
      value0: formatNumber(gb, { maximumFractionDigits: 20 }),
    });
  }

  private _getDiskSizeOptions(): number[] {
    return [32, 64, 128, 256, 512];
  }

  private _formatDiskSize(gb: number): string {
    return gb >= 1024
      ? localize("components.drive_card.value_tb", {
          value0: formatNumber(gb / 1024, { maximumFractionDigits: 20 }),
        })
      : localize("components.drive_card.value_gb", {
          value0: formatNumber(gb, { maximumFractionDigits: 20 }),
        });
  }

  private _getCpuDescription(): string {
    if (this._cpuCores <= 2) {
      return localize(
        "views.proxmox.proxmox_configure_view.minimum_for_basic_operation"
      );
    } else if (this._cpuCores <= 4) {
      return localize(
        "views.proxmox.proxmox_configure_view.recommended_for_most_users"
      );
    } else if (this._cpuCores <= 8) {
      return localize(
        "views.proxmox.proxmox_configure_view.better_performance_with_many_integrations"
      );
    } else {
      return localize(
        "views.proxmox.proxmox_configure_view.maximum_performance_for_power_users"
      );
    }
  }

  private _getMemoryDescription(): string {
    const gb = this._memoryMb / 1024;
    if (gb <= 2) {
      return localize(
        "views.proxmox.proxmox_configure_view.minimum_for_basic_operation"
      );
    } else if (gb <= 4) {
      return localize(
        "views.proxmox.proxmox_configure_view.recommended_for_most_users"
      );
    } else if (gb <= 8) {
      return localize(
        "views.proxmox.proxmox_configure_view.better_for_add_ons_and_many_integrations"
      );
    } else {
      return localize(
        "views.proxmox.proxmox_configure_view.maximum_performance_for_power_users"
      );
    }
  }

  private _getDiskDescription(): string {
    if (this._diskSizeGb <= 32) {
      return localize(
        "views.proxmox.proxmox_configure_view.good_for_getting_started"
      );
    } else if (this._diskSizeGb <= 64) {
      return localize(
        "views.proxmox.proxmox_configure_view.room_for_add_ons_and_history"
      );
    } else if (this._diskSizeGb <= 128) {
      return localize(
        "views.proxmox.proxmox_configure_view.plenty_of_space_for_long_term_use"
      );
    } else {
      return localize(
        "views.proxmox.proxmox_configure_view.extended_storage_for_recordings_and_backups"
      );
    }
  }

  // Icons
  private _renderServerIcon() {
    return html`<svg viewBox="0 0 24 24">
      <path
        d="M4,1H20A1,1 0 0,1 21,2V6A1,1 0 0,1 20,7H4A1,1 0 0,1 3,6V2A1,1 0 0,1 4,1M4,9H20A1,1 0 0,1 21,10V14A1,1 0 0,1 20,15H4A1,1 0 0,1 3,14V10A1,1 0 0,1 4,9M4,17H20A1,1 0 0,1 21,18V22A1,1 0 0,1 20,23H4A1,1 0 0,1 3,22V18A1,1 0 0,1 4,17M9,5H10V3H9V5M9,13H10V11H9V13M9,21H10V19H9V21M5,3V5H7V3H5M5,11V13H7V11H5M5,19V21H7V19H5Z"
      />
    </svg>`;
  }

  private _renderDatabaseIcon() {
    return html`<svg viewBox="0 0 24 24">
      <path
        d="M12,3C7.58,3 4,4.79 4,7C4,9.21 7.58,11 12,11C16.42,11 20,9.21 20,7C20,4.79 16.42,3 12,3M4,9V12C4,14.21 7.58,16 12,16C16.42,16 20,14.21 20,12V9C20,11.21 16.42,13 12,13C7.58,13 4,11.21 4,9M4,14V17C4,19.21 7.58,21 12,21C16.42,21 20,19.21 20,17V14C20,16.21 16.42,18 12,18C7.58,18 4,16.21 4,14Z"
      />
    </svg>`;
  }

  private _renderIdIcon() {
    return html`<svg viewBox="0 0 24 24">
      <path
        d="M9,7H11V15H9V7M13,7H15V15H13V7M5,3H19A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5A2,2 0 0,1 3,19V5A2,2 0 0,1 5,3M5,5V19H19V5H5Z"
      />
    </svg>`;
  }

  private _renderLabelIcon() {
    return html`<svg viewBox="0 0 24 24">
      <path
        d="M16,17H5V7H16L19.55,12M17.63,5.84C17.27,5.33 16.67,5 16,5H5A2,2 0 0,0 3,7V17A2,2 0 0,0 5,19H16C16.67,19 17.27,18.66 17.63,18.15L22,12L17.63,5.84Z"
      />
    </svg>`;
  }

  private _renderCpuIcon() {
    return html`<svg viewBox="0 0 24 24">
      <path
        d="M6,4H18V5H21V7H18V9H21V11H18V13H21V15H18V17H21V19H18V20H6V19H3V17H6V15H3V13H6V11H3V9H6V7H3V5H6V4M11,15V18H12V15H11M13,15V18H14V15H13M15,15V18H16V15H15Z"
      />
    </svg>`;
  }

  private _renderMemoryIcon() {
    return html`<svg viewBox="0 0 24 24">
      <path
        d="M17,17H7V7H17M21,11V9H19V7C19,5.89 18.1,5 17,5H15V3H13V5H11V3H9V5H7C5.89,5 5,5.89 5,7V9H3V11H5V13H3V15H5V17A2,2 0 0,0 7,19H9V21H11V19H13V21H15V19H17A2,2 0 0,0 19,17V15H21V13H19V11M13,13H11V11H13M15,9H9V15H15V9Z"
      />
    </svg>`;
  }

  private _renderDiskIcon() {
    return html`<svg viewBox="0 0 24 24">
      <path
        d="M12,3C7.58,3 4,4.79 4,7C4,9.21 7.58,11 12,11C16.42,11 20,9.21 20,7C20,4.79 16.42,3 12,3M4,9V12C4,14.21 7.58,16 12,16C16.42,16 20,14.21 20,12V9C20,11.21 16.42,13 12,13C7.58,13 4,11.21 4,9M4,14V17C4,19.21 7.58,21 12,21C16.42,21 20,19.21 20,17V14C20,16.21 16.42,18 12,18C7.58,18 4,16.21 4,14Z"
      />
    </svg>`;
  }

  render() {
    if (this._error) {
      return html`
        <h2>
          ${localize(
            "views.proxmox.proxmox_configure_view.configure_virtual_machine"
          )}
        </h2>
        <p class="subtitle">
          ${localize(
            "views.proxmox.proxmox_configure_view.configure_your_home_assistant_vm_on_proxmox"
          )}
        </p>
        <div class="config-card">
          <p class="error-text" role="alert" style="overflow-wrap: anywhere;">
            ${this._error.message}
          </p>
          ${renderErrorHelp()}
          ${this._sessionExpired || this._error.retryable
            ? html`<wa-button
                variant="brand"
                @click=${this._sessionExpired ? this._reconnect : this._retry}
                ?disabled=${this._loadingNodes || this._loadingStorage}
              >
                ${this._sessionExpired
                  ? localize("views.proxmox.proxmox_configure_view.reconnect")
                  : localize("components.app_shell.try_again")}
              </wa-button>`
            : ""}
        </div>
      `;
    }

    const coreOptions = this._getCoreOptions();
    const memoryOptions = this._getMemoryOptions();
    const diskSizeOptions = this._getDiskSizeOptions();

    const coreIndex = coreOptions.indexOf(this._cpuCores);
    const memoryIndex = memoryOptions.indexOf(this._memoryMb);
    const diskIndex = diskSizeOptions.indexOf(this._diskSizeGb);

    return html`
      <h2>
        ${localize(
          "views.proxmox.proxmox_configure_view.configure_virtual_machine"
        )}
      </h2>
      <p class="subtitle">
        ${localize(
          "views.proxmox.proxmox_configure_view.configure_your_home_assistant_vm_on_proxmox"
        )}
      </p>

      <div class="config-card">
        <!-- VM Name (Display Name) - First -->
        <div class="setting-row">
          <div class="setting-icon">${this._renderLabelIcon()}</div>
          <div class="setting-content">
            <wa-input
              label=${localize(
                "views.proxmox.proxmox_configure_view.display_name"
              )}
              type="text"
              size="s"
              .value=${this._vmName}
              @input=${this._onNameChange}
              placeholder="home-assistant"
              maxlength="63"
              pattern="[a-zA-Z0-9._-]+"
              title=${localize(
                "views.proxmox.proxmox_configure_view.only_letters_numbers_dash_underscore_and_period_allowed"
              )}
            ></wa-input>
            <p class="setting-description">
              ${localize(
                "views.proxmox.proxmox_configure_view.name_shown_in_proxmox_letters_numbers_dash_underscore_only"
              )}
            </p>
          </div>
        </div>

        <!-- Node Selection -->
        <div class="setting-row">
          <div class="setting-icon">${this._renderServerIcon()}</div>
          <div class="setting-content">
            ${this._loadingNodes
              ? html`<span class="loading-text"
                  >${localize(
                    "views.proxmox.proxmox_configure_view.loading_nodes"
                  )}</span
                >`
              : html`
                  <wa-select
                    label=${localize(
                      "views.proxmox.proxmox_configure_view.node"
                    )}
                    size="s"
                    .value=${this._selectedNode}
                    @change=${this._onNodeChange}
                  >
                    ${this._nodes.map(
                      (node) => html`
                        <wa-option value=${node.name}>
                          ${`${node.name}${
                            node.cpu_usage != null
                              ? ` ${localize(
                                  "views.proxmox.proxmox_configure_view.cpu_value",
                                  {
                                    value0: formatNumber(
                                      Number(node.cpu_usage.toFixed(1)),
                                      {
                                        minimumFractionDigits: 1,
                                        maximumFractionDigits: 1,
                                      }
                                    ),
                                  }
                                )}`
                              : ""
                          }`}
                        </wa-option>
                      `
                    )}
                  </wa-select>
                `}
            <p class="setting-description">
              ${localize(
                "views.proxmox.proxmox_configure_view.proxmox_node_where_the_vm_will_be_created"
              )}
            </p>
          </div>
        </div>

        <!-- Storage Selection -->
        <div class="setting-row">
          <div class="setting-icon">${this._renderDatabaseIcon()}</div>
          <div class="setting-content">
            ${this._loadingStorage
              ? html`<span class="loading-text"
                  >${localize(
                    "views.proxmox.proxmox_configure_view.loading_storage"
                  )}</span
                >`
              : html`
                  <wa-select
                    label=${localize("proxmox.storage_pool")}
                    size="s"
                    .value=${this._selectedStorage}
                    @change=${this._onStorageChange}
                    ?disabled=${this._storages.length === 0}
                  >
                    ${this._storages.map(
                      (storage) => html`
                        <wa-option value=${storage.name}>
                          ${localize(
                            "views.proxmox.proxmox_configure_view.value_value_free",
                            {
                              value0: storage.name,
                              value1: formatBytes(storage.available),
                            }
                          )}
                        </wa-option>
                      `
                    )}
                  </wa-select>
                `}
            <p class="setting-description">
              ${localize(
                "views.proxmox.proxmox_configure_view.storage_location_for_the_vm_disk_image"
              )}
            </p>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-icon">${this._renderServerIcon()}</div>
          <div class="setting-content">
            ${this._loadingStorage || this._loadingNodes
              ? html`<span class="loading-text"
                  >${localize(
                    "views.proxmox.proxmox_configure_view.loading_network_bridges"
                  )}</span
                >`
              : html`
                  <wa-select
                    id="network-bridge"
                    label=${localize(
                      "views.proxmox.proxmox_configure_view.network_bridge"
                    )}
                    size="s"
                    .value=${this._selectedBridge}
                    @change=${this._onBridgeChange}
                    ?disabled=${this._bridges.length === 0}
                  >
                    ${this._bridges.map(
                      (bridge) => html`
                        <wa-option value=${bridge.name}>
                          ${bridge.name}${bridge.network_type === "vnet"
                            ? ` ${localize(
                                "views.proxmox.proxmox_configure_view.sdn_vnet"
                              )}`
                            : ""}${bridge.comments
                            ? ` - ${bridge.comments.trim()}`
                            : ""}
                        </wa-option>
                      `
                    )}
                  </wa-select>
                  ${this._bridges.length === 0 &&
                  this._bridgesNode === this._selectedNode &&
                  !this._error
                    ? // A lookup error already offers its own retry above
                      html`<p class="error-text" role="alert">
                          ${this._selectedNode
                            ? localize(
                                "views.proxmox.proxmox_configure_view.no_network_bridges_available_on_this_node"
                              )
                            : localize(
                                "views.proxmox.proxmox_configure_view.no_online_proxmox_nodes_found"
                              )}
                        </p>
                        <wa-button
                          @click=${this._selectedNode
                            ? this._loadStorage
                            : this._loadNodes}
                          >${localize(
                            "components.app_shell.try_again"
                          )}</wa-button
                        >`
                    : ""}
                `}
          </div>
        </div>

        <!-- VM ID -->
        <div class="setting-row">
          <div class="setting-icon">${this._renderIdIcon()}</div>
          <div class="setting-content">
            <wa-input
              label=${localize("views.proxmox.proxmox_configure_view.vm_id")}
              type="number"
              size="s"
              .value=${String(this._vmId)}
              @input=${this._onVmIdChange}
              min="100"
              max="999999999"
            ></wa-input>
            <p class="setting-description">
              ${localize(
                "views.proxmox.proxmox_configure_view.unique_identifier_for_the_virtual_machine"
              )}
            </p>
          </div>
        </div>

        <!-- CPU Cores -->
        <div class="setting-row">
          <div class="setting-icon">${this._renderCpuIcon()}</div>
          <div class="setting-content">
            <wa-slider
              with-markers
              with-tooltip
              min="0"
              max=${coreOptions.length - 1}
              step="1"
              .value=${coreIndex >= 0 ? coreIndex : 1}
              @input=${this._onCoresChange}
              .valueFormatter=${(index: number) =>
                localize("views.proxmox.proxmox_configure_view.value_cores", {
                  value0: coreOptions[index],
                })}
              ><div slot="label" class="setting-header">
                <span class="setting-label"
                  >${localize(
                    "views.proxmox.proxmox_configure_view.cpu_cores"
                  )}</span
                ><span class="setting-value" aria-hidden="true"
                  >${localize(
                    "views.proxmox.proxmox_configure_view.value_cores",
                    { value0: this._cpuCores }
                  )}</span
                >
              </div></wa-slider
            >
            <p class="setting-description">${this._getCpuDescription()}</p>
          </div>
        </div>

        <!-- Memory -->
        <div class="setting-row">
          <div class="setting-icon">${this._renderMemoryIcon()}</div>
          <div class="setting-content">
            <wa-slider
              with-markers
              with-tooltip
              min="0"
              max=${memoryOptions.length - 1}
              step="1"
              .value=${memoryIndex >= 0 ? memoryIndex : 1}
              @input=${this._onMemoryChange}
              .valueFormatter=${(index: number) =>
                this._formatMemory(memoryOptions[index])}
              ><div slot="label" class="setting-header">
                <span class="setting-label"
                  >${localize(
                    "views.proxmox.proxmox_configure_view.memory"
                  )}</span
                ><span class="setting-value" aria-hidden="true"
                  >${this._formatMemory(this._memoryMb)}</span
                >
              </div></wa-slider
            >
            <p class="setting-description">${this._getMemoryDescription()}</p>
          </div>
        </div>

        <!-- Disk Size -->
        <div class="setting-row">
          <div class="setting-icon">${this._renderDiskIcon()}</div>
          <div class="setting-content">
            <wa-slider
              with-markers
              with-tooltip
              min="0"
              max=${diskSizeOptions.length - 1}
              step="1"
              .value=${diskIndex >= 0 ? diskIndex : 0}
              @input=${this._onDiskSizeChange}
              .valueFormatter=${(index: number) =>
                this._formatDiskSize(diskSizeOptions[index])}
              ><div slot="label" class="setting-header">
                <span class="setting-label"
                  >${localize(
                    "views.proxmox.proxmox_configure_view.disk_size"
                  )}</span
                ><span class="setting-value" aria-hidden="true"
                  >${this._formatDiskSize(this._diskSizeGb)}</span
                >
              </div></wa-slider
            >
            <p class="setting-description">${this._getDiskDescription()}</p>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "proxmox-configure-view": ProxmoxConfigureView;
  }
}
