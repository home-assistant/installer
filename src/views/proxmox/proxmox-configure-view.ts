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
import { VmSettings, configCardStyles } from "../../utils/vm-settings.js";
import { renderStepHeading, stepStyles } from "../../utils/step-styles.js";
import { renderRetryButton } from "../../utils/load-state.js";

// MDI icons only this view uses; utils/icons.ts has the shared ones
const vmIdIcon =
  "M9,7H11V15H9V7M13,7H15V15H13V7M5,3H19A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5A2,2 0 0,1 3,19V5A2,2 0 0,1 5,3M5,5V19H19V5H5Z";
const mdiInformationOutline =
  "M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z";

/** A line of the hint next to Next */
interface NextHint {
  text: string;
  /** Try again found it, and its row takes the focus to say so */
  focused: boolean;
}

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
    configCardStyles,
    css`
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

      /* Last on the step, and at its foot when the step is short, so it is
         next to the Next it explains. Empty, it takes no room. */
      .next-hint {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        width: 100%;
        max-width: 500px;
        margin-top: auto;
        font-size: 0.875rem;
        line-height: 1.4;
        color: var(--ha-secondary-text-color, #727272);
        overflow-wrap: anywhere;
      }

      .next-hint.shown {
        padding-top: 1.5rem;
      }

      .next-hint svg {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
        fill: currentColor;
      }

      .next-hint p {
        margin: 0;
      }

      .next-hint p + p,
      .next-hint [role="status"]:not(:empty) + p {
        margin-top: 0.25rem;
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

  /** The VM's name and resources */
  private readonly _vm = new VmSettings(this, {
    defaultName: DEFAULT_PROXMOX_VM_NAME,
    // Says what Proxmox would reject, and "home-" stays typeable on the way
    // to "home-assistant"
    nameError: (name) =>
      VM_NAME_PATTERN.test(name)
        ? undefined
        : localize("views.proxmox.proxmox_configure_view.vm_name_invalid"),
    nameHint: () =>
      localize("views.proxmox.proxmox_configure_view.vm_name_hint"),
    maxNameLength: 63,
    save: () => this._saveSelections(),
  });

  /** Raw text of the VM ID field, so it never changes while typing */
  @state()
  private _vmIdText = String(DEFAULT_PROXMOX_VM_ID);

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
    this._vm.restore(selections);

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
        !this._vm.nameError &&
        !this._vmIdError,
      proxmoxImportReady: lookup.loaded && lookup.importStorage.ready,
      ...this._vm.selections,
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

  private _getCoreOptions(): number[] {
    const lookup = this._lookup;
    return coreOptionsFor(
      lookup.nodes.find((node) => node.name === lookup.selectedNode)?.cpu_count
    );
  }

  /** Lower a chosen or restored core count to what the selected node has. */
  private _fitCoresToNode() {
    this._vm.set({
      cpuCores: fitCores(this._vm.cpuCores, this._getCoreOptions()),
    });
  }

  render() {
    const error = this._lookup.error ?? this._retrying;
    // One template either way, so the hint's live region stays in place while
    // a failed lookup gives way to the form, and is heard once it fills
    return html`
      ${renderStepHeading(
        localize("common.vm.configure_virtual_machine"),
        localize("views.proxmox.proxmox_configure_view.subtitle")
      )}
      ${error ? this._renderLookupError(error) : this._renderForm()}
      ${this._renderNextHint()}
    `;
  }

  /** A lookup that failed, in place of the form */
  private _renderLookupError(error: InstallerError) {
    return html`
      <div class="config-card">
        <!-- Empty while trying again, so the same failure is read out again -->
        <p class="error-text" data-focus-alert style="overflow-wrap: anywhere;">
          ${this._retrying ? "" : error.message}
        </p>
        ${renderErrorHelp()}
        ${this._lookup.sessionExpired
          ? html`<wa-button
              class="reconnect"
              variant="brand"
              @click=${this._reconnect}
            >
              ${localize("common.proxmox.reconnect")}
            </wa-button>`
          : error.retryable
            ? renderRetryButton(!!this._retrying, () => this._retry(), {
                className: "load-retry",
              })
            : ""}
      </div>
    `;
  }

  private _renderForm() {
    const lookup = this._lookup;
    return html`
      <p class="sr-only" role="status">${lookup.importStorage.status}</p>

      <div class="config-card">
        ${this._vm.renderName()}

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
                    label=${localize(
                      "views.proxmox.proxmox_configure_view.storage_pool"
                    )}
                    size="s"
                    .value=${lookup.selectedStorage}
                    @change=${this._onStorageChange}
                    ?disabled=${lookup.storages.length === 0}
                  >
                    ${lookup.storages.map(
                      (storage) => html`
                        <wa-option value=${storage.name}>
                          ${localize("common.proxmox.storage_free", {
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
                // Only what Try again finds takes the focus; a lookup nobody
                // asked for is said near Next. Try again stays, busy, while it
                // reads; the text is empty meanwhile, so the same result is
                // read out again.
                html`<p
                    class="error-text"
                    ?data-focus-alert=${lookup.askedFrom === "storage"}
                  >
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
                      // Like the storage one, it takes the focus only when
                      // Try again finds it, and is empty while trying again,
                      // so the same result is read out again.
                      html`<p
                          class="error-text"
                          ?data-focus-alert=${lookup.askedFrom === "bridges"}
                        >
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
              required
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

        ${this._vm.renderResources(this._getCoreOptions(), MEMORY_OPTIONS_MB)}
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
        ? html`<p class="error-text" data-focus-alert>
            ${this._checkError.message}
          </p>`
        : ""}
    `;
  }

  /**
   * What the latest lookup found missing that Next needs. The disabled
   * button can't say, and the row that does may be scrolled away.
   */
  private _nextHints(): NextHint[] {
    const lookup = this._lookup;
    if (!lookup.loaded) return [];
    const node = lookup.selectedNode;
    // The bridge row's Try again, whose row also says when no node is online
    const bridgeRetried =
      lookup.askedFrom === "bridges" && lookup.bridgesNode === node;
    if (!node) {
      return [
        {
          text: localize(
            "views.proxmox.proxmox_configure_view.next_hint_no_node"
          ),
          focused: bridgeRetried,
        },
      ];
    }
    const hints: NextHint[] = [];
    if (lookup.storagesNode === node && lookup.storages.length === 0) {
      hints.push({
        text: localize(
          "views.proxmox.proxmox_configure_view.next_hint_no_storage",
          { node }
        ),
        focused: lookup.askedFrom === "storage",
      });
    }
    if (lookup.bridgesNode === node && lookup.bridges.length === 0) {
      hints.push({
        text: localize(
          "views.proxmox.proxmox_configure_view.next_hint_no_bridge",
          { node }
        ),
        focused: bridgeRetried,
      });
    }
    if (lookup.storagesNode === node && !lookup.importStorage.ready) {
      hints.push({
        text: localize(
          "views.proxmox.proxmox_configure_view.next_hint_no_import_storage",
          { node }
        ),
        focused: false,
      });
    }
    return hints;
  }

  /**
   * The hint is read out through a polite status, so a lookup that finishes
   * while someone types says what it found without taking the focus from
   * them. The status is always there, so it is in place before it says
   * anything. What a row takes the focus to say stays out of it, so it isn't
   * read out twice.
   */
  private _renderNextHint() {
    const hints = this._nextHints();
    const lines = (focused: boolean) =>
      hints
        .filter((hint) => hint.focused === focused)
        .map((hint) => html`<p>${hint.text}</p>`);
    return html`<div class="next-hint ${hints.length ? "shown" : ""}">
      ${hints.length
        ? html`<svg viewBox="0 0 24 24" aria-hidden="true">
            <path d=${mdiInformationOutline} />
          </svg>`
        : ""}
      <div>
        <div role="status">${lines(false)}</div>
        ${lines(true)}
      </div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "proxmox-configure-view": ProxmoxConfigureView;
  }
}
