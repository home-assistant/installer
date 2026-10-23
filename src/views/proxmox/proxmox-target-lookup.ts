import type { ReactiveController, ReactiveControllerHost } from "lit";
import {
  proxmoxGetNextVmId,
  proxmoxListBridges,
  proxmoxListNodes,
  proxmoxListStorage,
} from "../../api/commands.js";
import type {
  ProxmoxBridge,
  ProxmoxNode,
  ProxmoxSession,
  ProxmoxStorage,
} from "../../api/types.js";
import { localize } from "../../localization/localize.js";
import {
  wizardState,
  type WizardSelections,
} from "../../state/wizard-state.js";
import { InstallDiagnostics } from "../../utils/diagnostics.js";
import {
  installerError,
  type InstallerError,
} from "../../utils/installer-error.js";
import { ProxmoxImportStorage } from "./proxmox-import-storage.js";
import {
  SESSION_EXPIRED,
  forgetProxmoxSession,
  needsReconnect,
} from "./proxmox-session.js";

/**
 * Where a lookup was started from, if from a button that would otherwise
 * vanish while it runs. That part stays, busy.
 */
export type ReloadFrom = "import" | "nodes" | "bridges" | "storage";

/** What the lookup needs from the view whose form it fills */
export interface ProxmoxTargetForm {
  /** The session the view knows of, which every lookup uses */
  session(): ProxmoxSession | undefined;
  /** The nodes are in, with the next free VM ID as a suggestion */
  nodesLoaded(nextVmId: number): void;
  /** Save the view's selections, which include the lookup's */
  save(): void;
}

/**
 * The online nodes of a Proxmox server, and the storage and network bridges
 * of the selected one, as the configure step offers them. A lookup that
 * finishes after the step was left, after the session changed, or after a
 * newer one started changes nothing.
 */
export class ProxmoxTargetLookup implements ReactiveController {
  nodes: ProxmoxNode[] = [];
  storages: ProxmoxStorage[] = [];
  bridges: ProxmoxBridge[] = [];
  loadingNodes = true;
  loadingStorage = false;
  error: InstallerError | null = null;
  sessionExpired = false;
  selectedNode = "";
  selectedStorage = "";
  selectedBridge = "";
  /** Node whose storage lookup last completed, so an empty list is real. */
  storagesNode = "";
  /** Node whose bridge lookup last completed, so an empty list is real. */
  bridgesNode = "";
  /** Where the running lookup was started from, see `ReloadFrom` */
  reloadFrom?: ReloadFrom;
  /**
   * Where the latest lookup was started from, still known once it finished.
   * What it found there was asked for; what it found anywhere else wasn't.
   */
  askedFrom?: ReloadFrom;
  /** Whether the node's storage accepts Import, and the consent to enable it */
  readonly importStorage = new ProxmoxImportStorage(this);

  /** Bumped per storage lookup, so only the latest one applies its result */
  private _storageLookup = 0;
  /** A lookup that finishes once the step was left must not save */
  private _connected = false;

  constructor(
    private readonly _host: ReactiveControllerHost,
    private readonly _form: ProxmoxTargetForm
  ) {
    _host.addController(this);
  }

  hostConnected() {
    this._connected = true;
  }

  hostDisconnected() {
    this._connected = false;
  }

  /** Choices are judged only against a lookup that finished without error. */
  get loaded(): boolean {
    return !this.loadingNodes && !this.loadingStorage && !this.error;
  }

  get connected(): boolean {
    return this._connected;
  }

  get session(): ProxmoxSession | undefined {
    return this._form.session();
  }

  /** The latest storage lookup, which a newer one replaces */
  get storageLookup(): number {
    return this._storageLookup;
  }

  requestUpdate() {
    this._host.requestUpdate();
  }

  /**
   * Start from what is already in the wizard state, so stepping back to an
   * earlier step and forward again keeps the user's choices.
   */
  restore(selections: WizardSelections) {
    this.selectedNode = selections.proxmoxNode ?? "";
    this.selectedStorage = selections.proxmoxStorage ?? "";
    this.selectedBridge = selections.proxmoxBridge ?? "";
    this.requestUpdate();
  }

  /** The node's storage and bridges are not known until they are read. */
  selectNode(node: string) {
    this.selectedNode = node;
    this.selectedStorage = "";
    this.storagesNode = "";
    this.selectedBridge = "";
    this.bridges = [];
    this.bridgesNode = "";
    this.requestUpdate();
  }

  selectStorage(storage: string) {
    this.selectedStorage = storage;
    this.requestUpdate();
  }

  selectBridge(bridge: string) {
    this.selectedBridge = bridge;
    this.requestUpdate();
  }

  async loadNodes(from?: "nodes") {
    this.loadingNodes = true;
    this.reloadFrom = from;
    this.askedFrom = from;
    this.error = null;
    this.sessionExpired = false;
    this.requestUpdate();
    // Preserve choices across reconnects, but block Next until revalidated.
    wizardState.setSelection("proxmoxConfigureReady", false);
    this.importStorage.reset();
    const session = this._form.session();
    const isCurrentSession = () => this._form.session() === session;

    // The connect step only moves on with a session, so this follows an
    // expiry that cleared it, and the expiry text says what to do
    if (!session) {
      this.setError({
        code: SESSION_EXPIRED,
        message: localize("proxmox.session_expired"),
        retryable: false,
        details: {},
      });
      this.loadingNodes = false;
      return;
    }

    try {
      const results = await Promise.allSettled([
        proxmoxListNodes(session),
        proxmoxGetNextVmId(session),
      ]);

      // The user may have left this step while the lookups were in flight;
      // saving now would write over what the next step reads
      if (!this.connected || !isCurrentSession()) return;

      // An expired session must take precedence over an ordinary failure
      // from the other lookup, regardless of which one finishes first.
      const failures = results.filter((result) => result.status === "rejected");
      const failure =
        failures.find((result) => needsReconnect(result.reason)) ?? failures[0];
      if (failure) throw failure.reason;
      const nodes = (results[0] as PromiseFulfilledResult<ProxmoxNode[]>).value;
      const nextVmId = (results[1] as PromiseFulfilledResult<number>).value;

      this.nodes = nodes.filter((n) => n.status === "online");

      // Keep a restored node as long as it is still online
      const nodeStillOnline = this.nodes.some(
        (n) => n.name === this.selectedNode
      );
      if (!nodeStillOnline) {
        this.selectedNode = this.nodes[0]?.name ?? "";
        this.selectedBridge = "";
        this.bridges = [];
      }
      this.requestUpdate();
      this._form.nodesLoaded(nextVmId);

      if (this.selectedNode) {
        await this.loadStorage(from);
        // The storage lookup is another chance to have left this step
        if (!this.connected || !isCurrentSession()) return;
      }

      this._form.save();
    } catch (error) {
      if (!this.connected || !isCurrentSession()) return;
      this.setError(error);
    } finally {
      this.loadingNodes = false;
      this.reloadFrom = undefined;
      this.requestUpdate();
      if (this.connected && isCurrentSession()) this._form.save();
    }
  }

  async loadStorage(from?: ReloadFrom) {
    if (!this.selectedNode) return;

    const session = this._form.session();

    if (!session) return;

    const node = this.selectedNode;
    // Switching nodes quickly can have lookups finish out of order, even two
    // for the same node; only the latest one may update the storage
    const lookup = ++this._storageLookup;
    const isLatest = () => lookup === this._storageLookup;
    const isCurrentSession = () => this._form.session() === session;

    this.loadingStorage = true;
    this.reloadFrom = from;
    this.askedFrom = from;
    // A new lookup replaces the previous one's error; an expired session
    // never gets here, since it clears the session first
    this.error = null;
    this.sessionExpired = false;
    this.requestUpdate();
    wizardState.setSelections({
      proxmoxConfigureReady: false,
      proxmoxBridgeReady: false,
    });
    this.importStorage.reset(from === "import");
    try {
      const [storageResult, bridgeResult] = await Promise.allSettled([
        proxmoxListStorage(session, node),
        proxmoxListBridges(session, node),
      ]);

      if (!this.connected || !isCurrentSession()) return;

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
        this.importStorage.read(storageResult.value, from === "import");

        // Filter to only show storage that supports VM images
        this.storages = storageResult.value.filter(
          (s) => s.active && s.content.includes("images")
        );
        this.storagesNode = node;

        // Keep the selected storage if this node still offers it, otherwise
        // fall back to the first one available
        const storageStillAvailable = this.storages.some(
          (s) => s.name === this.selectedStorage
        );
        if (!storageStillAvailable) {
          this.selectedStorage = this.storages[0]?.name ?? "";
        }
      } else {
        this.storages = [];
      }

      if (bridgeResult.status === "fulfilled") {
        this.bridges = bridgeResult.value;
        this.bridgesNode = node;
        if (
          !this.bridges.some((bridge) => bridge.name === this.selectedBridge)
        ) {
          this.selectedBridge =
            this.bridges.find((bridge) => bridge.name === "vmbr0")?.name ??
            this.bridges[0]?.name ??
            "";
        }
      } else {
        this.bridges = [];
      }
      this.requestUpdate();

      const failure = expired ?? failures[0];
      if (failure) throw failure.reason;

      this._form.save();
    } catch (error) {
      if (!this.connected || !isCurrentSession()) return;
      if (!isLatest()) {
        // Session expiry applies to every node, even if this lookup was
        // superseded. Ordinary failures still belong to the old selection.
        if (needsReconnect(error)) {
          this.setError(error);
        }
        return;
      }
      // The lists were already updated above; keep the choices for
      // retry/reconnect while readiness prevents using them.
      this._form.save();
      this.setError(error);
    } finally {
      // A newer lookup is still running and owns the loading state
      if (isLatest()) {
        this.loadingStorage = false;
        // The node lookup this one is part of still runs, and clears it once
        // done; the part it started from would vanish in between
        if (!this.loadingNodes) this.reloadFrom = undefined;
        this.importStorage.busy = false;
        this.requestUpdate();
        if (this.connected && isCurrentSession()) this._form.save();
      }
    }
  }

  setError(error: unknown) {
    // Only reached for the current, connected lookup, so detached or
    // superseded lookups never add diagnostics
    new InstallDiagnostics("proxmox").fail(error);
    this.sessionExpired = needsReconnect(error);
    this.error = installerError(
      error,
      localize(
        "views.proxmox.proxmox_target_lookup.failed_to_load_proxmox_configuration"
      )
    );
    this.requestUpdate();
    if (this.sessionExpired) forgetProxmoxSession();
    wizardState.setSelections({
      proxmoxConfigureReady: false,
      proxmoxImportReady: false,
    });
  }
}
