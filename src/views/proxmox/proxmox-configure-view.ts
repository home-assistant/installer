import {
  installerError,
  renderErrorHelp,
  type InstallerError,
} from "../../utils/installer-error.js";
import { formatNumber, localize } from "../../localization/localize.js";
import { LitElement, html, css, noChange } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../../utils/view-accessibility.js";
import { InstallDiagnostics } from "../../utils/diagnostics.js";
import { customElement, state } from "lit/decorators.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import "@home-assistant/webawesome/dist/components/input/input.js";
import type WaSelect from "@home-assistant/webawesome/dist/components/select/select.js";
import "@home-assistant/webawesome/dist/components/select/select.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import {
  proxmoxListNodes,
  proxmoxListStorage,
  proxmoxListBridges,
  proxmoxEnableStorageImport,
  proxmoxGetNextVmId,
  proxmoxCheckVmConfig,
  formatBytes,
} from "../../api/commands.js";
import type {
  ProxmoxBridge,
  ProxmoxNode,
  ProxmoxStorage,
} from "../../api/types.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "../../components/info-dialog.js";
import { openExternalLink } from "../../utils/external-url.js";
import "@home-assistant/webawesome/dist/components/details/details.js";
import {
  DEFAULT_CPU_CORES,
  DEFAULT_DISK_SIZE_GB,
  DEFAULT_MEMORY_MB,
  DEFAULT_PROXMOX_VM_ID,
  DEFAULT_PROXMOX_VM_NAME,
  proxmoxVmConfig,
} from "../../state/vm-defaults.js";
import { settingStyles } from "../../utils/setting-styles.js";
import {
  SESSION_EXPIRED,
  forgetProxmoxSession,
  needsReconnect,
} from "./proxmox-session.js";
import "../../components/vm-resources.js";
import type { VmResourceValues } from "../../components/vm-resources.js";

const DIRECTORY_STORAGE_DOCS =
  "https://pve.proxmox.com/pve-docs/pve-admin-guide.html#storage_directory";

/**
 * Proxmox's `dns-name` format: dot-separated labels of letters, digits and
 * dashes, each starting and ending with a letter or digit. Proxmox only
 * checks it when it creates the VM, after the download and the upload.
 */
const VM_NAME_LABEL = "[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?";
const VM_NAME_PATTERN = new RegExp(`^${VM_NAME_LABEL}(\\.${VM_NAME_LABEL})*$`);

/** The VM IDs Proxmox accepts */
const MIN_VM_ID = 100;
const MAX_VM_ID = 999_999_999;

const CORE_OPTIONS = [2, 4, 6, 8, 10, 12, 16];

/** A whole number from min to max, or undefined */
function parseWholeNumber(
  text: string,
  min: number,
  max: number
): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return value >= min && value <= max ? value : undefined;
}

@customElement("proxmox-configure-view")
export class ProxmoxConfigureView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    reducedMotionStyles,
    settingStyles,
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

      .config-card {
        display: flex;
        flex-direction: column;
        gap: 1.75rem;
        padding: 1rem 1.25rem;
        background-color: var(--ha-card-background, #ffffff);
        border: 1px solid var(--ha-border-color, #e0e0e0);
        border-radius: var(--ha-card-border-radius, 12px);
        width: 100%;
        box-sizing: border-box;
        max-width: 500px;
      }

      wa-details {
        width: 100%;
        max-width: 500px;
        margin-top: 1rem;
        flex-shrink: 0;
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

      .import-setting {
        gap: 0.75rem;
        overflow-wrap: anywhere;
      }

      .import-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
      }

      .import-setting a {
        font-size: 0.875rem;
        color: var(--ha-primary-color, #03a9f4);
      }
    `,
  ];

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

  /** Raw text of the VM ID field, so it never changes while typing */
  @state()
  private _vmIdText = String(DEFAULT_PROXMOX_VM_ID);

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
  /** The node has active storage with room that already accepts Import. */
  @state() private _importReady = false;
  /** Active directory storage on the node that Import could be enabled on. */
  @state() private _importCandidates: ProxmoxStorage[] = [];
  @state() private _importStorage = "";
  @state() private _importBusy = false;
  @state() private _importDialog = false;
  @state() private _importDeclined = false;
  @state() private _importError: InstallerError | null = null;
  /** Why Proxmox would reject these settings, until one of them changes */
  @state() private _checkError: InstallerError | null = null;
  /** Raw text of the VLAN field; empty keeps today's untagged network. */
  @state() private _vlanTag = "";

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = wizardState.subscribe((state) => {
      this._wizardState = state;
    });
    this._restoreSelections();
    wizardState.setSelection("proxmoxBridgeReady", false);
    wizardState.setSelection("proxmoxImportReady", false);
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
    this._vlanTag = selections.proxmoxVlanTag?.toString() ?? "";
    this._vmName = selections.vmName ?? DEFAULT_PROXMOX_VM_NAME;
    this._cpuCores = selections.cpuCores ?? DEFAULT_CPU_CORES;
    this._memoryMb = selections.memoryMb ?? DEFAULT_MEMORY_MB;
    this._diskSizeGb = selections.diskSizeGb ?? DEFAULT_DISK_SIZE_GB;

    if (selections.proxmoxVmId !== undefined) {
      this._vmIdText = String(selections.proxmoxVmId);
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
    this._resetImport();
    const session = this._wizardState.selections.proxmoxSession;
    const isCurrentSession = () =>
      this._wizardState.selections.proxmoxSession === session;

    // The connect step only moves on with a session, so this follows an
    // expiry that cleared it, and the expiry text says what to do
    if (!session) {
      this._setError({
        code: SESSION_EXPIRED,
        message: localize("utils.installer_error.proxmox_session_expired"),
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
      const failure =
        failures.find((result) => needsReconnect(result.reason)) ?? failures[0];
      if (failure) throw failure.reason;
      const nodes = (results[0] as PromiseFulfilledResult<ProxmoxNode[]>).value;
      const nextVmId = (results[1] as PromiseFulfilledResult<number>).value;

      this._nodes = nodes.filter((n) => n.status === "online");

      // The next free VM ID is only a suggestion - never overwrite an ID the
      // user has already been shown and may have changed
      if (!this._vmIdChosen) {
        this._vmIdText = String(nextVmId);
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
      this._fitCoresToNode();

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
    this._resetImport();
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
      const expired = failures.find((result) => needsReconnect(result.reason));
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
        // The image is uploaded to import storage before the VM disk is made.
        // ESXi only advertises Import as a source, and a full storage cannot
        // take the upload either.
        this._importReady = storageResult.value.some(
          (s) =>
            s.active &&
            s.storage_type !== "esxi" &&
            s.available > 0 &&
            s.content.includes("import")
        );
        this._importCandidates = storageResult.value.filter(
          (s) =>
            s.active &&
            s.storage_type === "dir" &&
            s.available > 0 &&
            !s.content.includes("import")
        );
        this._importStorage = this._importCandidates[0]?.name ?? "";

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

      const failure = expired ?? failures[0];
      if (failure) throw failure.reason;

      this._saveSelections();
    } catch (error) {
      if (!this.isConnected || !isCurrentSession()) return;
      if (!isLatest()) {
        // Session expiry applies to every node, even if this lookup was
        // superseded. Ordinary failures still belong to the old selection.
        if (needsReconnect(error)) {
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

  /**
   * Run the checks the install starts with, so a problem shows here, where
   * it can be fixed. Resolves false if one fails, or if the settings changed
   * or the step was left while Proxmox answered.
   */
  async check(): Promise<boolean> {
    const selections = wizardState.getState().selections;
    const session = selections.proxmoxSession;
    if (!session) return false;
    const isCurrent = () =>
      this.isConnected && wizardState.getState().selections === selections;

    // The previous answer stays until this one arrives: removing the alert
    // would move focus back to the heading on every retry
    try {
      await proxmoxCheckVmConfig(session, proxmoxVmConfig(selections));
      if (!isCurrent()) return false;
      this._checkError = null;
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      if (needsReconnect(error)) {
        this._setError(error);
      } else {
        new InstallDiagnostics("proxmox").fail(error);
        this._checkError = installerError(error);
      }
      return false;
    }
  }

  private _setError(error: unknown) {
    // Only reached for the current, connected lookup, so detached or
    // superseded lookups never add diagnostics
    new InstallDiagnostics("proxmox").fail(error);
    this._sessionExpired = needsReconnect(error);
    this._error = installerError(
      error,
      localize(
        "views.proxmox.proxmox_configure_view.failed_to_load_proxmox_configuration"
      )
    );
    if (this._sessionExpired) forgetProxmoxSession();
    wizardState.setSelection("proxmoxConfigureReady", false);
    wizardState.setSelection("proxmoxImportReady", false);
  }

  /** Forget the previous lookup's Import state until storage is read again. */
  private _resetImport() {
    this._importReady = false;
    this._importCandidates = [];
    this._importStorage = "";
    this._importBusy = false;
    this._importDialog = false;
    this._importDeclined = false;
    this._importError = null;
    wizardState.setSelection("proxmoxImportReady", false);
  }

  /**
   * Enable Import on the storage the user just agreed to. This changes the
   * cluster-wide storage configuration, so it only ever runs from the
   * consent dialog, never from loading or selecting storage.
   */
  private async _enableImport() {
    if (!this._importDialog || this._importBusy || this._loadingStorage) return;
    this._importDialog = false;

    const session = this._wizardState.selections.proxmoxSession;
    const node = this._selectedNode;
    const storage = this._importStorage;
    if (!session || !this._importCandidates.some((s) => s.name === storage))
      return;

    const lookup = this._storageLookup;
    const flowGeneration = wizardState.flowGeneration;
    const isCurrent = () =>
      this.isConnected &&
      this._wizardState.selections.proxmoxSession === session &&
      lookup === this._storageLookup &&
      node === this._selectedNode;

    this._importBusy = true;
    this._importError = null;
    try {
      const changed = await proxmoxEnableStorageImport(session, node, storage);
      // The change is cluster-wide, so leaving the step or picking another
      // node does not undo it. Only a newer flow must not inherit it.
      if (
        changed &&
        wizardState.flowGeneration === flowGeneration &&
        wizardState.getState().currentFlow === "proxmox"
      ) {
        this._rememberImportChange(session.server_url, storage);
      }
      if (!isCurrent()) return;
      // Only a fresh read decides readiness, so the step never trusts its
      // own assumption about what the server now has
      await this._loadStorage();
    } catch (error) {
      if (!isCurrent()) return;
      if (needsReconnect(error)) {
        this._setError(error);
        return;
      }
      new InstallDiagnostics("proxmox").fail(error);
      this._importError = installerError(
        error,
        localize("views.proxmox.proxmox_configure_view.failed_to_enable_import")
      );
    } finally {
      if (isCurrent()) this._importBusy = false;
    }
  }

  /** Remember a change once per server, for the post-install reminder. */
  private _rememberImportChange(serverUrl: string, storage: string) {
    // A renewed login may spell the same server differently
    const serverOrigin = new URL(serverUrl).origin;
    const changes =
      wizardState.getState().selections.proxmoxImportChanges ?? [];
    if (
      changes.some(
        (change) =>
          change.serverOrigin === serverOrigin && change.storage === storage
      )
    )
      return;

    wizardState.setSelection("proxmoxImportChanges", [
      ...changes,
      { serverOrigin, storage },
    ]);
  }

  private _onImportStorageChange(e: Event) {
    const select = e.target as WaSelect;
    this._importStorage = select.value as string;
    this._importDeclined = false;
    this._importError = null;
  }

  private _askToEnableImport() {
    this._importDeclined = false;
    this._importDialog = true;
  }

  private _declineImport() {
    this._importDialog = false;
    this._importDeclined = true;
  }

  private _retry() {
    if (this._loadingNodes || this._loadingStorage) return;
    void this._loadNodes();
  }

  private _reconnect() {
    wizardState.goToStep(0);
  }

  /** Choices are judged only against a lookup that finished without error. */
  private get _loaded(): boolean {
    return !this._loadingNodes && !this._loadingStorage && !this._error;
  }

  private get _parsedVlanTag(): number | undefined {
    return parseWholeNumber(this._vlanTag, 1, 4094);
  }

  private get _vlanError(): string | undefined {
    if (!this._vlanTag) return undefined;
    if (this._parsedVlanTag === undefined) {
      return localize(
        "views.proxmox.proxmox_configure_view.vlan_tag_must_be_a_whole_number"
      );
    }
    if (
      this._loaded &&
      !this._bridges.find((bridge) => bridge.name === this._selectedBridge)
        ?.vlan_aware
    ) {
      return localize(
        "views.proxmox.proxmox_configure_view.select_a_vlan_aware_bridge_or_remove_the_vlan_tag"
      );
    }
    return undefined;
  }

  /** A set tag changes the VM's network and can block Next: never hide it */
  private _keepVlanTagShown(e: Event) {
    if (this._vlanTag && e.target === e.currentTarget) e.preventDefault();
  }

  private _onVlanInput(e: Event) {
    this._vlanTag = (e.target as WaInput).value ?? "";
    this._saveSelections();
  }

  private _saveSelections() {
    this._checkError = null;
    wizardState.setSelection("proxmoxNode", this._selectedNode);
    wizardState.setSelection("proxmoxStorage", this._selectedStorage);
    wizardState.setSelection("proxmoxBridge", this._selectedBridge);
    wizardState.setSelection("proxmoxVlanTag", this._parsedVlanTag);
    wizardState.setSelection(
      "proxmoxBridgeReady",
      this._loaded &&
        this._bridges.some((bridge) => bridge.name === this._selectedBridge)
    );
    wizardState.setSelection(
      "proxmoxConfigureReady",
      this._loaded && !this._vlanError && !this._nameError && !this._vmIdError
    );
    wizardState.setSelection(
      "proxmoxImportReady",
      this._loaded && this._importReady
    );
    // A failed initial lookup must not turn the fallback ID into a choice
    // that suppresses the next-free-ID suggestion after reconnecting.
    // An ID that isn't valid yet is left out, so the one typed before it
    // can't reach the check or the install
    if (this._vmIdChosen) {
      wizardState.setSelection("proxmoxVmId", this._parsedVmId);
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
    this._fitCoresToNode();
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

  private get _parsedVmId(): number | undefined {
    return parseWholeNumber(this._vmIdText, MIN_VM_ID, MAX_VM_ID);
  }

  private get _vmIdError(): string | undefined {
    if (this._parsedVmId !== undefined) return undefined;
    return localize("views.proxmox.proxmox_configure_view.vm_id_invalid", {
      min: MIN_VM_ID,
      max: MAX_VM_ID,
    });
  }

  private _onVmIdChange(e: Event) {
    // Kept as typed, like the name: falling back to a default here put it
    // in front of whatever was typed next. _vmIdError holds Next back.
    this._vmIdText = (e.target as WaInput).value ?? "";
    this._vmIdChosen = true;
    this._saveSelections();
  }

  private get _nameError(): string | undefined {
    return VM_NAME_PATTERN.test(this._vmName)
      ? undefined
      : localize("views.proxmox.proxmox_configure_view.vm_name_invalid");
  }

  private _onNameChange(e: Event) {
    // Kept as typed: rewriting the field while typing didn't always reach
    // it, so it could show another name than the one used. _nameError says
    // what Proxmox would reject, and "home-" stays typeable on the way.
    this._vmName = (e.target as WaInput).value ?? "";
    this._saveSelections();
  }

  private _onResourcesChange(e: CustomEvent<VmResourceValues>) {
    this._cpuCores = e.detail.cpuCores;
    this._memoryMb = e.detail.memoryMb;
    this._diskSizeGb = e.detail.diskSizeGb;
    this._saveSelections();
  }

  /** Proxmox creates a VM with more cores than its node has, then won't start it. */
  private _getCoreOptions(): number[] {
    const cpus = this._nodes.find(
      (node) => node.name === this._selectedNode
    )?.cpu_count;
    if (!cpus) return CORE_OPTIONS;
    const fitting = CORE_OPTIONS.filter((cores) => cores <= cpus);
    return fitting.length ? fitting : [cpus];
  }

  /** Lower a chosen or restored core count to what the selected node has. */
  private _fitCoresToNode() {
    const options = this._getCoreOptions();
    if (options.includes(this._cpuCores)) return;
    this._cpuCores =
      options.filter((cores) => cores <= this._cpuCores).pop() ??
      options[0] ??
      this._cpuCores;
  }

  private _getMemoryOptions(): number[] {
    return [2048, 4096, 6144, 8192, 12288, 16384, 24576, 32768];
  }

  private _getDiskSizeOptions(): number[] {
    return [32, 64, 128, 256, 512];
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

  private _renderImport() {
    if (!this._selectedNode || !this._loaded || this._importReady) return "";

    const candidates = this._importCandidates;
    const selected = candidates.find((s) => s.name === this._importStorage);

    return html`
      <div class="setting-row">
        <div class="setting-icon">${this._renderDatabaseIcon()}</div>
        <div class="setting-content import-setting">
          <span class="setting-label"
            >${localize(
              "views.proxmox.proxmox_configure_view.import_storage_required"
            )}</span
          >
          <p class="setting-description">
            ${localize(
              "views.proxmox.proxmox_configure_view.no_import_storage_on_node",
              { node: this._selectedNode }
            )}
          </p>
          ${this._importDeclined
            ? html`<p class="setting-description" role="status">
                ${localize(
                  "views.proxmox.proxmox_configure_view.import_not_enabled_paused"
                )}
              </p>`
            : ""}
          ${candidates.length > 1
            ? html`<wa-select
                label=${localize(
                  "views.proxmox.proxmox_configure_view.import_storage"
                )}
                size="s"
                .value=${this._importStorage}
                ?disabled=${this._importBusy}
                @change=${this._onImportStorageChange}
              >
                ${candidates.map(
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
              </wa-select>`
            : selected
              ? html`<p class="setting-description">
                  ${localize(
                    "views.proxmox.proxmox_configure_view.import_can_be_enabled_on_storage",
                    {
                      storage: selected.name,
                      free: formatBytes(selected.available),
                    }
                  )}
                </p>`
              : html`<p class="setting-description">
                  ${localize(
                    "views.proxmox.proxmox_configure_view.no_storage_to_enable_import_on"
                  )}
                </p>`}
          ${this._importError
            ? html`<p class="error-text" role="alert">
                  ${this._importError.message}
                </p>
                <p class="setting-description">
                  ${localize(
                    "views.proxmox.proxmox_configure_view.check_storage_permissions_and_try_again"
                  )}
                </p>`
            : ""}
          <div class="import-actions">
            ${selected
              ? html`<wa-button
                  variant="brand"
                  size="s"
                  ?disabled=${this._importBusy}
                  @click=${this._askToEnableImport}
                >
                  ${this._importBusy
                    ? localize(
                        "views.proxmox.proxmox_configure_view.enabling_import"
                      )
                    : localize(
                        "views.proxmox.proxmox_configure_view.enable_import_ellipsis"
                      )}
                </wa-button>`
              : ""}
            <wa-button
              appearance="outlined"
              size="s"
              ?disabled=${this._importBusy}
              @click=${this._loadStorage}
            >
              ${localize(
                "views.proxmox.proxmox_configure_view.refresh_storage"
              )}
            </wa-button>
          </div>
          <a href=${DIRECTORY_STORAGE_DOCS} @click=${openExternalLink}
            >${localize("proxmox.directory_storage_documentation")}</a
          >
        </div>
      </div>
      <info-dialog
        .open=${this._importDialog}
        heading=${localize(
          "views.proxmox.proxmox_configure_view.enable_import_on_storage_title"
        )}
        .message=${localize(
          "views.proxmox.proxmox_configure_view.enable_import_on_storage_message",
          { storage: this._importStorage }
        )}
        primary-label=${localize(
          "views.proxmox.proxmox_configure_view.enable_import"
        )}
        secondary-label=${localize(
          "views.proxmox.proxmox_configure_view.not_now"
        )}
        @dialog-primary=${this._enableImport}
        @dialog-secondary=${this._declineImport}
      ></info-dialog>
    `;
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
                  ? localize("proxmox.reconnect")
                  : localize("components.app_shell.try_again")}
              </wa-button>`
            : ""}
        </div>
      `;
    }

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
              .customError=${this._nameError ?? null}
            >
              <!-- In the hint slot, so the field describes itself with it.
                Not role="alert": ViewAccessibility focuses a new alert, which
                would pull focus out of the field halfway through typing -->
              <span slot="hint" class="name-hint" aria-live="polite"
                >${this._nameError ??
                localize(
                  "views.proxmox.proxmox_configure_view.vm_name_hint"
                )}</span
              >
            </wa-input>
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
                    ?disabled=${this._importBusy}
                  >
                    ${this._nodes.map(
                      (node) => html`
                        <wa-option value=${node.name}>
                          ${`${node.name}${
                            node.cpu_usage != null
                              ? ` ${localize(
                                  "views.proxmox.proxmox_configure_view.cpu_value",
                                  {
                                    // Proxmox reports a fraction (0.15 is 15%)
                                    value0: formatNumber(node.cpu_usage, {
                                      style: "percent",
                                      maximumFractionDigits: 1,
                                    }),
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

        ${this._renderImport()}

        <!-- VM ID -->
        <div class="setting-row">
          <div class="setting-icon">${this._renderIdIcon()}</div>
          <div class="setting-content">
            <wa-input
              label=${localize("views.proxmox.proxmox_configure_view.vm_id")}
              type="number"
              size="s"
              .value=${this._vmIdText}
              @input=${this._onVmIdChange}
              min=${MIN_VM_ID}
              max=${MAX_VM_ID}
              .customError=${this._vmIdError ?? null}
            >
              <!-- In the hint slot and not role="alert", like the name hint -->
              <span slot="hint" class="vm-id-hint" aria-live="polite"
                >${this._vmIdError ??
                localize(
                  "views.proxmox.proxmox_configure_view.unique_identifier_for_the_virtual_machine"
                )}</span
              >
            </wa-input>
          </div>
        </div>

        <vm-resources
          .coreOptions=${this._getCoreOptions()}
          .memoryOptions=${this._getMemoryOptions()}
          .diskOptions=${this._getDiskSizeOptions()}
          .cpuCores=${this._cpuCores}
          .memoryMb=${this._memoryMb}
          .diskSizeGb=${this._diskSizeGb}
          @resources-change=${this._onResourcesChange}
        ></vm-resources>
      </div>
      <wa-details
        appearance="plain"
        summary=${localize("views.proxmox.proxmox_configure_view.advanced")}
        ?open=${!!this._vlanTag || noChange}
        @wa-hide=${this._keepVlanTagShown}
      >
        <wa-input
          id="vlan-tag"
          label=${localize(
            "views.proxmox.proxmox_configure_view.vlan_tag_optional"
          )}
          inputmode="numeric"
          .value=${this._vlanTag}
          @input=${this._onVlanInput}
          .customError=${this._vlanError ?? null}
        >
          <!-- Not role="alert": ViewAccessibility focuses a new alert, which
            took focus out of the field as soon as a digit made it invalid -->
          <span slot="hint" class="vlan-hint" aria-live="polite"
            >${this._vlanError ??
            (this._vlanTag
              ? ""
              : localize(
                  "views.proxmox.proxmox_configure_view.untagged"
                ))}</span
          >
        </wa-input>
      </wa-details>
      ${this._checkError
        ? html`<p class="error-text" role="alert">
            ${this._checkError.message}
          </p>`
        : ""}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "proxmox-configure-view": ProxmoxConfigureView;
  }
}
