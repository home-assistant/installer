import {
  installerError,
  renderErrorHelp,
  type InstallerError,
} from "../../utils/installer-error.js";
import { linkStyles } from "../../utils/link-styles.js";
import { formatNumber, localize } from "../../localization/localize.js";
import { LitElement, html, css, noChange } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
  srOnlyStyles,
} from "../../utils/view-accessibility.js";
import { InstallDiagnostics } from "../../utils/diagnostics.js";
import { customElement, query, state } from "lit/decorators.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import "@home-assistant/webawesome/dist/components/input/input.js";
import type WaSelect from "@home-assistant/webawesome/dist/components/select/select.js";
import "@home-assistant/webawesome/dist/components/select/select.js";
import {
  wizardState,
  type WizardSelections,
  type WizardState,
} from "../../state/wizard-state.js";
import { proxmoxCheckVmConfig } from "../../api/commands.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
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
import { formatFreeSpace } from "../../utils/format.js";
import { fieldError, fieldErrorStyles } from "../../utils/field-error.js";
import { mdiDatabase, mdiServer } from "../../utils/icons.js";
import { needsReconnect } from "./proxmox-session.js";
import { ProxmoxTargetLookup } from "./proxmox-target-lookup.js";
import {
  importStorageStyles,
  type ImportStorageActions,
} from "./proxmox-import-storage.js";
import {
  DISK_SIZE_OPTIONS_GB,
  MAX_VLAN_TAG,
  MAX_VM_ID,
  MEMORY_OPTIONS_MB,
  MIN_VLAN_TAG,
  MIN_VM_ID,
  VM_NAME_PATTERN,
  coreOptionsFor,
  fitCores,
  parseWholeNumber,
} from "./proxmox-validation.js";
import "../../components/vm-resources.js";
import type { VmResourceValues } from "../../components/vm-resources.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";
import { renderRetryButton } from "../../utils/load-state.js";

// MDI icons only this view uses; utils/icons.ts has the shared ones
const labelIcon =
  "M16,17H5V7H16L19.55,12M17.63,5.84C17.27,5.33 16.67,5 16,5H5A2,2 0 0,0 3,7V17A2,2 0 0,0 5,19H16C16.67,19 17.27,18.66 17.63,18.15L22,12L17.63,5.84Z";
const vmIdIcon =
  "M9,7H11V15H9V7M13,7H15V15H13V7M5,3H19A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5A2,2 0 0,1 3,19V5A2,2 0 0,1 5,3M5,5V19H19V5H5Z";

function renderIcon(path: string) {
  return html`<svg viewBox="0 0 24 24"><path d=${path} /></svg>`;
}

@customElement("proxmox-configure-view")
export class ProxmoxConfigureView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    stepStyles,
    srOnlyStyles,
    reducedMotionStyles,
    settingStyles,
    fieldErrorStyles,
    linkStyles,
    css`
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

      /* Web Awesome animates the expand from script for these durations,
         which the reduced-motion sheet can't reach */
      @media (prefers-reduced-motion: reduce) {
        wa-details {
          --show-duration: 0s;
          --hide-duration: 0s;
        }

        wa-details::part(icon) {
          transition: none;
        }
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
    `,
    importStorageStyles,
  ];

  @state()
  private _wizardState: WizardState = wizardState.getState();

  /** The nodes, storage and bridges to choose from, and Import on them */
  private readonly _lookup = new ProxmoxTargetLookup(this, {
    session: () => this._wizardState.selections.proxmoxSession,
    nodesLoaded: (nextVmId) => {
      // The next free VM ID is only a suggestion - never overwrite an ID the
      // user has already been shown and may have changed
      if (!this._vmIdChosen) {
        this._vmIdText = String(nextVmId);
        this._vmIdChosen = true;
      }
      this._fitCoresToNode();
    },
    save: () => this._saveSelections(),
  });

  /** The Import section leaves the focus to the view */
  private readonly _importActions: ImportStorageActions = {
    enable: () => this._enableImport(),
    refresh: () => this._refreshStorage(),
    dialogHidden: () => this._onImportDialogHidden(),
  };

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

  // Where focus continues after a lookup hid the button that started it
  @query(".enable-import") private _enableImportButton?: HTMLElement;
  @query(".refresh-storage") private _refreshStorageButton?: HTMLElement;
  @query(".bridge-retry") private _bridgeRetryButton?: HTMLElement;
  @query("#network-bridge") private _bridgeSelect?: HTMLElement;
  @query(".storage-retry") private _storageRetryButton?: HTMLElement;
  @query("#storage") private _storageSelect?: HTMLElement;
  /** What the lookup error offers: Try again, or Reconnect */
  @query(".load-retry, .reconnect") private _loadRetryButton?: HTMLElement;
  @query("h2") private _heading?: HTMLElement;
  /** The lookup error Try again is retrying, kept on screen meanwhile */
  @state() private _retrying: InstallerError | null = null;
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
    // Next waits until the lookups below verify these again
    wizardState.setSelections({
      proxmoxConfigureReady: false,
      proxmoxBridgeReady: false,
      proxmoxImportReady: false,
    });
    void this._lookup.loadNodes();
  }

  /**
   * Seed the form from what is already in the wizard state, so stepping back
   * to an earlier step and forward again keeps the user's settings. The
   * defaults above only apply on the first visit.
   */
  private _restoreSelections() {
    const selections = this._wizardState.selections;
    this._lookup.restore(selections);
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
        this._lookup.setError(error);
      } else {
        new InstallDiagnostics("proxmox").fail(error);
        this._checkError = installerError(error);
      }
      return false;
    }
  }

  private async _enableImport() {
    if (await this._lookup.importStorage.enable()) {
      // Reading storage again hid the section holding the button
      await this._restoreFocus(
        () => this._enableImportButton ?? this._bridgeSelect
      );
    }
  }

  private async _retry() {
    const lookup = this._lookup;
    if (lookup.loadingNodes || lookup.loadingStorage) return;
    this._retrying = lookup.error;
    await lookup.loadNodes();
    this._retrying = null;
    // The settings, or Reconnect, can take the place of Try again, which had
    // the focus
    await this._restoreFocus(() => this._loadRetryButton ?? this._heading);
  }

  /** The dialog hands focus back to nothing: continue from its button. */
  private _onImportDialogHidden() {
    this._accessibility.restoreFocus(
      this._enableImportButton ?? this._bridgeSelect
    );
  }

  private async _refreshStorage() {
    await this._lookup.loadStorage("import");
    await this._restoreFocus(
      () => this._refreshStorageButton ?? this._bridgeSelect
    );
  }

  private async _retryStorage() {
    await this._lookup.loadStorage("storage");
    await this._restoreFocus(
      () => this._storageRetryButton ?? this._storageSelect
    );
  }

  private async _retryBridges() {
    await (this._lookup.selectedNode
      ? this._lookup.loadStorage("bridges")
      : this._lookup.loadNodes("bridges"));
    await this._restoreFocus(
      () => this._bridgeRetryButton ?? this._bridgeSelect
    );
  }

  /**
   * After a lookup that hid the button starting it, continue from what
   * `target` finds once it has rendered. Focus moved elsewhere stays.
   */
  private async _restoreFocus(target: () => HTMLElement | undefined) {
    await this.updateComplete;
    if (!this.isConnected) return;
    const element = target();
    // A select this update enabled takes that on in its own update, and
    // can't take focus before
    await (element as { updateComplete?: Promise<unknown> } | undefined)
      ?.updateComplete;
    this._accessibility.restoreFocus(element);
  }

  private _reconnect() {
    wizardState.goToStep(0);
  }

  private get _parsedVlanTag(): number | undefined {
    return parseWholeNumber(this._vlanTag, MIN_VLAN_TAG, MAX_VLAN_TAG);
  }

  private get _vlanError(): string | undefined {
    if (!this._vlanTag) return undefined;
    if (this._parsedVlanTag === undefined) {
      return localize("views.proxmox.proxmox_configure_view.vlan_tag_invalid");
    }
    const lookup = this._lookup;
    if (
      lookup.loaded &&
      !lookup.bridges.find((bridge) => bridge.name === lookup.selectedBridge)
        ?.vlan_aware
    ) {
      return localize(
        "views.proxmox.proxmox_configure_view.vlan_needs_aware_bridge"
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
    const lookup = this._lookup;
    const selections: Partial<WizardSelections> = {
      proxmoxNode: lookup.selectedNode,
      proxmoxStorage: lookup.selectedStorage,
      proxmoxBridge: lookup.selectedBridge,
      proxmoxVlanTag: this._parsedVlanTag,
      proxmoxBridgeReady:
        lookup.loaded &&
        lookup.bridges.some((bridge) => bridge.name === lookup.selectedBridge),
      proxmoxConfigureReady:
        lookup.loaded &&
        !this._vlanError &&
        !this._nameError &&
        !this._vmIdError,
      proxmoxImportReady: lookup.loaded && lookup.importStorage.ready,
      vmName: this._vmName,
      cpuCores: this._cpuCores,
      memoryMb: this._memoryMb,
      diskSizeGb: this._diskSizeGb,
    };
    // A failed initial lookup must not turn the fallback ID into a choice
    // that suppresses the next-free-ID suggestion after reconnecting.
    // An ID that isn't valid yet is left out, so the one typed before it
    // can't reach the check or the install
    if (this._vmIdChosen) {
      selections.proxmoxVmId = this._parsedVmId;
    }
    wizardState.setSelections(selections);
  }

  private async _onNodeChange(e: Event) {
    const select = e.target as WaSelect;
    this._lookup.selectNode(select.value as string);
    this._fitCoresToNode();
    this._saveSelections();
    await this._lookup.loadStorage();
  }

  private _onBridgeChange(e: Event) {
    const select = e.target as WaSelect;
    this._lookup.selectBridge(select.value as string);
    this._saveSelections();
  }

  private _onStorageChange(e: Event) {
    const select = e.target as WaSelect;
    this._lookup.selectStorage(select.value as string);
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

  private _getCoreOptions(): number[] {
    const lookup = this._lookup;
    return coreOptionsFor(
      lookup.nodes.find((node) => node.name === lookup.selectedNode)?.cpu_count
    );
  }

  /** Lower a chosen or restored core count to what the selected node has. */
  private _fitCoresToNode() {
    this._cpuCores = fitCores(this._cpuCores, this._getCoreOptions());
  }

  render() {
    const lookup = this._lookup;
    const error = lookup.error ?? this._retrying;
    if (error) {
      return html`
        ${renderStepHeading(
          localize("common.vm.configure_virtual_machine"),
          localize("views.proxmox.proxmox_configure_view.subtitle")
        )}
        <div class="config-card">
          <!-- Empty while trying again, so the same failure is read out again -->
          <p class="error-text" role="alert" style="overflow-wrap: anywhere;">
            ${this._retrying ? "" : error.message}
          </p>
          ${renderErrorHelp()}
          ${lookup.sessionExpired
            ? html`<wa-button
                class="reconnect"
                variant="brand"
                @click=${this._reconnect}
              >
                ${localize("proxmox.reconnect")}
              </wa-button>`
            : error.retryable
              ? renderRetryButton(!!this._retrying, () => this._retry(), {
                  className: "load-retry",
                })
              : ""}
        </div>
      `;
    }

    return html`
      ${renderStepHeading(
        localize("common.vm.configure_virtual_machine"),
        localize("views.proxmox.proxmox_configure_view.subtitle")
      )}
      <p class="sr-only" role="status">${lookup.importStorage.status}</p>

      <div class="config-card">
        <!-- VM Name (Display Name) - First -->
        <div class="setting-row">
          <div class="setting-icon">${renderIcon(labelIcon)}</div>
          <div class="setting-content">
            <wa-input
              label=${localize("common.vm.display_name")}
              type="text"
              size="s"
              .value=${this._vmName}
              @input=${this._onNameChange}
              placeholder="home-assistant"
              maxlength="63"
              ${fieldError(this._nameError)}
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
          <div class="setting-icon">${renderIcon(mdiServer)}</div>
          <div class="setting-content">
            ${lookup.loadingNodes
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
                    .value=${lookup.selectedNode}
                    @change=${this._onNodeChange}
                    ?disabled=${lookup.importStorage.busy}
                  >
                    ${lookup.nodes.map(
                      (node) => html`
                        <wa-option value=${node.name}>
                          ${`${node.name}${
                            node.cpu_usage != null
                              ? ` ${localize(
                                  "views.proxmox.proxmox_configure_view.node_cpu_usage",
                                  {
                                    // Proxmox reports a fraction (0.15 is 15%)
                                    percent: formatNumber(node.cpu_usage, {
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
              ${localize("views.proxmox.proxmox_configure_view.node_hint")}
            </p>
          </div>
        </div>

        <!-- Storage Selection -->
        <div class="setting-row">
          <div class="setting-icon">${renderIcon(mdiDatabase)}</div>
          <div class="setting-content">
            ${lookup.loadingStorage && lookup.reloadFrom !== "storage"
              ? html`<span class="loading-text"
                  >${localize(
                    "views.proxmox.proxmox_configure_view.loading_storage"
                  )}</span
                >`
              : html`
                  <wa-select
                    id="storage"
                    label=${localize("proxmox.storage_pool")}
                    size="s"
                    .value=${lookup.selectedStorage}
                    @change=${this._onStorageChange}
                    ?disabled=${lookup.storages.length === 0}
                  >
                    ${lookup.storages.map(
                      (storage) => html`
                        <wa-option value=${storage.name}>
                          ${localize("proxmox.storage_free", {
                            storage: storage.name,
                            free: formatFreeSpace(storage.available),
                          })}
                        </wa-option>
                      `
                    )}
                  </wa-select>
                `}
            <p class="setting-description">
              ${localize("views.proxmox.proxmox_configure_view.storage_hint")}
            </p>
            ${lookup.reloadFrom === "storage" ||
            (lookup.loaded &&
              lookup.selectedNode &&
              lookup.storagesNode === lookup.selectedNode &&
              lookup.storages.length === 0)
              ? // Next needs storage for the VM disk, so say how to get one.
                // Like Refresh storage, retrying waits while Import is enabled.
                // Try again stays, busy, while it reads; the alert is empty
                // meanwhile, so the same result is read out again.
                html`<p class="error-text" role="alert">
                    ${lookup.reloadFrom === "storage"
                      ? ""
                      : localize(
                          "views.proxmox.proxmox_configure_view.no_disk_storage_on_node"
                        )}
                  </p>
                  ${renderRetryButton(
                    lookup.reloadFrom === "storage",
                    () => this._retryStorage(),
                    {
                      className: "storage-retry",
                      disabled: lookup.importStorage.busy,
                    }
                  )}`
              : ""}
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-icon">${renderIcon(mdiServer)}</div>
          <div class="setting-content">
            ${(lookup.loadingStorage || lookup.loadingNodes) &&
            lookup.reloadFrom !== "bridges"
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
                    .value=${lookup.selectedBridge}
                    @change=${this._onBridgeChange}
                    ?disabled=${lookup.bridges.length === 0}
                  >
                    ${lookup.bridges.map(
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
                  ${lookup.reloadFrom === "bridges" ||
                  (lookup.bridges.length === 0 &&
                    lookup.bridgesNode === lookup.selectedNode &&
                    !lookup.error)
                    ? // A lookup error already offers its own retry above.
                      // Empty while trying again, so the same result is read
                      // out again.
                      html`<p class="error-text" role="alert">
                          ${lookup.reloadFrom === "bridges"
                            ? ""
                            : lookup.selectedNode
                              ? localize(
                                  "views.proxmox.proxmox_configure_view.no_bridges"
                                )
                              : localize(
                                  "views.proxmox.proxmox_configure_view.no_online_proxmox_nodes_found"
                                )}
                        </p>
                        ${renderRetryButton(
                          lookup.reloadFrom === "bridges",
                          () => this._retryBridges(),
                          { className: "bridge-retry" }
                        )}`
                    : ""}
                `}
          </div>
        </div>

        ${lookup.importStorage.render(this._importActions)}

        <!-- VM ID -->
        <div class="setting-row">
          <div class="setting-icon">${renderIcon(vmIdIcon)}</div>
          <div class="setting-content">
            <wa-input
              label=${localize("views.proxmox.proxmox_configure_view.vm_id")}
              type="number"
              size="s"
              .value=${this._vmIdText}
              @input=${this._onVmIdChange}
              min=${MIN_VM_ID}
              max=${MAX_VM_ID}
              ${fieldError(this._vmIdError)}
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
          .memoryOptions=${MEMORY_OPTIONS_MB}
          .diskOptions=${DISK_SIZE_OPTIONS_GB}
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
          ${fieldError(this._vlanError)}
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
