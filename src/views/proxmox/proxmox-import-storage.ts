import { css, html } from "lit";
import type WaSelect from "@home-assistant/webawesome/dist/components/select/select.js";
import "@home-assistant/webawesome/dist/components/select/select.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "../../components/info-dialog.js";
import { proxmoxEnableStorageImport } from "../../api/commands.js";
import type { ProxmoxStorage } from "../../api/types.js";
import { localize } from "../../localization/localize.js";
import { wizardState } from "../../state/wizard-state.js";
import { InstallDiagnostics } from "../../utils/diagnostics.js";
import { openExternalLink } from "../../utils/external-url.js";
import { formatFreeSpace } from "../../utils/format.js";
import { mdiDatabase } from "../../utils/icons.js";
import {
  installerError,
  type InstallerError,
} from "../../utils/installer-error.js";
import { needsReconnect } from "./proxmox-session.js";
import type { ProxmoxTargetLookup } from "./proxmox-target-lookup.js";

const DIRECTORY_STORAGE_DOCS =
  "https://pve.proxmox.com/pve-docs/pve-admin-guide.html#storage_directory";

/** The Import section's own rules, next to the view's setting rows */
export const importStorageStyles = css`
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
  }
`;

/** What the Import section leaves to the view, which looks after the focus */
export interface ImportStorageActions {
  /** The consent dialog's Enable Import */
  enable(): unknown;
  refresh(): unknown;
  /** The consent dialog closed */
  dialogHidden(): unknown;
}

/** Remember a change once per server, for the post-install reminder. */
function rememberImportChange(serverUrl: string, storage: string) {
  // A renewed login may spell the same server differently
  const serverOrigin = new URL(serverUrl).origin;
  const changes = wizardState.getState().selections.proxmoxImportChanges ?? [];
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

/**
 * Whether the selected node has storage that accepts Import, which the
 * image is uploaded to before the VM disk is made. Without it, the section
 * offers to enable Import on a directory storage, once the user agrees.
 *
 * It renders into the view, so the view's alerts and focus handling cover it.
 */
export class ProxmoxImportStorage {
  /** The node has active storage with room that already accepts Import. */
  ready = false;
  /** Active directory storage on the node that Import could be enabled on. */
  candidates: ProxmoxStorage[] = [];
  /** The candidate to enable Import on */
  selected = "";
  busy = false;
  dialog = false;
  declined = false;
  error: InstallerError | null = null;
  /** Said once Import is enabled, as its section then goes away */
  status = "";

  constructor(private readonly _lookup: ProxmoxTargetLookup) {}

  /**
   * Forget the previous lookup's Import state until storage is read again.
   * With `keepShown`, the section stays on screen meanwhile, busy, so the
   * button that started the lookup keeps focus. It is never ready meanwhile.
   */
  reset(keepShown = false) {
    this.status = "";
    this.ready = false;
    this.dialog = false;
    this.declined = false;
    this.error = null;
    this._lookup.requestUpdate();
    wizardState.setSelection("proxmoxImportReady", false);
    if (keepShown) return;
    this.candidates = [];
    this.selected = "";
    this.busy = false;
  }

  /** Take in the node's storage; `fromImport` if this section read it. */
  read(storages: ProxmoxStorage[], fromImport: boolean) {
    // The image is uploaded to import storage before the VM disk is made.
    // ESXi only advertises Import as a source, and a full storage cannot
    // take the upload either.
    const importStorage = storages.find(
      (s) =>
        s.active &&
        s.storage_type !== "esxi" &&
        s.available > 0 &&
        s.content.includes("import")
    );
    this.ready = importStorage !== undefined;
    // Read from the Import section, which goes away now: say why, whether
    // this step enabled it or it was enabled in Proxmox meanwhile
    if (fromImport && importStorage) {
      this.status = localize(
        "views.proxmox.proxmox_import_storage.import_enabled_on_storage",
        { storage: importStorage.name }
      );
    }
    this.candidates = storages.filter(
      (s) =>
        s.active &&
        s.storage_type === "dir" &&
        s.available > 0 &&
        !s.content.includes("import")
    );
    this.selected = this.candidates[0]?.name ?? "";
    this._lookup.requestUpdate();
  }

  /**
   * Enable Import on the storage the user just agreed to. This changes the
   * cluster-wide storage configuration, so it only ever runs from the
   * consent dialog, never from loading or selecting storage. Resolves true
   * once it has read the storage again, which hid this section.
   */
  async enable(): Promise<boolean> {
    const lookup = this._lookup;
    if (!this.dialog || this.busy || lookup.loadingStorage) return false;
    this.dialog = false;
    lookup.requestUpdate();

    const session = lookup.session;
    const node = lookup.selectedNode;
    const storage = this.selected;
    if (!session || !this.candidates.some((s) => s.name === storage))
      return false;

    const storageLookup = lookup.storageLookup;
    const flowGeneration = wizardState.flowGeneration;
    const isCurrent = () =>
      lookup.connected &&
      lookup.session === session &&
      storageLookup === lookup.storageLookup &&
      node === lookup.selectedNode;

    this.busy = true;
    this.error = null;
    try {
      const changed = await proxmoxEnableStorageImport(session, node, storage);
      // The change is cluster-wide, so leaving the step or picking another
      // node does not undo it. Only a newer flow must not inherit it.
      if (
        changed &&
        wizardState.flowGeneration === flowGeneration &&
        wizardState.getState().currentFlow === "proxmox"
      ) {
        rememberImportChange(session.server_url, storage);
      }
      if (!isCurrent()) return false;
      // Only a fresh read decides readiness, so the step never trusts its
      // own assumption about what the server now has
      await lookup.loadStorage("import");
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      if (needsReconnect(error)) {
        lookup.setError(error);
        return false;
      }
      new InstallDiagnostics("proxmox").fail(error);
      this.error = installerError(
        error,
        localize("views.proxmox.proxmox_import_storage.failed_to_enable_import")
      );
      return false;
    } finally {
      if (isCurrent()) this.busy = false;
      lookup.requestUpdate();
    }
  }

  // Called by Lit with the view as `this`, so bound here
  private readonly _onStorageChange = (e: Event) => {
    const select = e.target as WaSelect;
    this.selected = select.value as string;
    this.declined = false;
    this.error = null;
    this._lookup.requestUpdate();
  };

  private readonly _ask = () => {
    this.declined = false;
    this.dialog = true;
    this._lookup.requestUpdate();
  };

  private readonly _decline = () => {
    this.dialog = false;
    this.declined = true;
    this._lookup.requestUpdate();
  };

  render(actions: ImportStorageActions) {
    const lookup = this._lookup;
    // A read started from this section keeps it on screen, busy
    const keptForReload =
      lookup.loadingStorage && lookup.reloadFrom === "import";
    if (
      !lookup.selectedNode ||
      (!lookup.loaded && !keptForReload) ||
      this.ready
    )
      return "";
    const reloading = lookup.loadingStorage && !this.busy;

    const candidates = this.candidates;
    const selected = candidates.find((s) => s.name === this.selected);

    return html`
      <div class="setting-row">
        <div class="setting-icon">
          <svg viewBox="0 0 24 24"><path d=${mdiDatabase} /></svg>
        </div>
        <div class="setting-content import-setting">
          <span class="setting-label"
            >${localize(
              "views.proxmox.proxmox_import_storage.import_storage_required"
            )}</span
          >
          <p class="setting-description">
            ${localize(
              "views.proxmox.proxmox_import_storage.no_import_storage_on_node",
              { node: lookup.selectedNode }
            )}
          </p>
          ${this.declined
            ? html`<p class="setting-description" role="status">
                ${localize(
                  "views.proxmox.proxmox_import_storage.import_not_enabled_paused"
                )}
              </p>`
            : ""}
          ${candidates.length > 1
            ? html`<wa-select
                label=${localize(
                  "views.proxmox.proxmox_import_storage.import_storage"
                )}
                size="s"
                .value=${this.selected}
                ?disabled=${this.busy || reloading}
                @change=${this._onStorageChange}
              >
                ${candidates.map(
                  (storage) => html`
                    <wa-option value=${storage.name}>
                      ${localize("proxmox.storage_free", {
                        storage: storage.name,
                        free: formatFreeSpace(storage.available),
                      })}
                    </wa-option>
                  `
                )}
              </wa-select>`
            : selected
              ? html`<p class="setting-description">
                  ${localize(
                    "views.proxmox.proxmox_import_storage.import_can_be_enabled_on_storage",
                    {
                      storage: selected.name,
                      free: formatFreeSpace(selected.available),
                    }
                  )}
                </p>`
              : html`<p class="setting-description">
                  ${localize(
                    "views.proxmox.proxmox_import_storage.no_storage_to_enable_import_on"
                  )}
                </p>`}
          ${this.error
            ? html`<p class="error-text" role="alert">${this.error.message}</p>
                <p class="setting-description">
                  ${localize(
                    "views.proxmox.proxmox_import_storage.check_storage_permissions_and_try_again"
                  )}
                </p>`
            : ""}
          <div class="import-actions">
            ${selected
              ? html`<wa-button
                  class="enable-import"
                  variant="brand"
                  size="s"
                  ?loading=${this.busy}
                  ?disabled=${reloading}
                  @click=${this._ask}
                >
                  ${this.busy
                    ? localize(
                        "views.proxmox.proxmox_import_storage.enabling_import"
                      )
                    : localize(
                        "views.proxmox.proxmox_import_storage.enable_import_ellipsis"
                      )}
                </wa-button>`
              : ""}
            <wa-button
              class="refresh-storage"
              appearance="outlined"
              size="s"
              ?disabled=${this.busy}
              ?loading=${reloading}
              @click=${actions.refresh}
            >
              ${localize(
                "views.proxmox.proxmox_import_storage.refresh_storage"
              )}
            </wa-button>
          </div>
          <a href=${DIRECTORY_STORAGE_DOCS} @click=${openExternalLink}
            >${localize("proxmox.directory_storage_documentation")}</a
          >
        </div>
      </div>
      <info-dialog
        .open=${this.dialog}
        @wa-after-hide=${actions.dialogHidden}
        heading=${localize(
          "views.proxmox.proxmox_import_storage.enable_import_on_storage_title"
        )}
        .message=${localize(
          "views.proxmox.proxmox_import_storage.enable_import_on_storage_message",
          { storage: this.selected }
        )}
        primary-label=${localize(
          "views.proxmox.proxmox_import_storage.enable_import"
        )}
        secondary-label=${localize(
          "views.proxmox.proxmox_import_storage.not_now"
        )}
        @dialog-primary=${actions.enable}
        @dialog-secondary=${this._decline}
      ></info-dialog>
    `;
  }
}
