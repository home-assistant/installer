import { localize } from "../localization/localize.js";
import type {
  DeviceType,
  HaosConfig,
  ProxmoxSession,
  ProxmoxVmResult,
  UtmVmConfig,
  WifiConfig,
} from "../api/types.js";
import type { InstallationPath } from "../views/path-selection-view.js";
import type { HaHardwareId } from "../views/ha-hardware/hardware.js";
import { supportsWifi } from "../utils/wifi.js";

export type WizardFlow = InstallationPath;

export interface WizardStep {
  id: string;
  title: string;
}

/**
 * Values collected while stepping through a flow.
 *
 * Views write and read these independently, so every key is declared and a
 * misspelled key or mistyped value fails the build.
 */
export interface WizardSelections {
  device?: string;
  /** Shown on the summary screens for the selected device. */
  deviceName?: string;
  deviceImage?: string;
  /** The current device picker has successfully refreshed board availability. */
  deviceCatalogReady?: boolean;
  /** HAOS image of the selected device; its board picks the image to flash. */
  deviceConfig?: HaosConfig;
  /** Nabu Casa device picked in the Home Assistant hardware flow. */
  haHardware?: HaHardwareId;
  /** Device id of the selected drive; also the path sent to the backend. */
  drive?: string;
  /** Rest of the selected drive's identity, kept so it can be re-verified. */
  driveName?: string;
  driveSize?: number;
  driveModel?: string;
  driveVendor?: string;
  driveSerial?: string;
  /** Shown as the drive's icon on the confirmation screen. */
  driveType?: DeviceType;
  /** Network to add to the drive. Its password is cleared once written. */
  wifi?: WifiConfig;

  /** VM configuration, shared by the UTM and Proxmox "Configure VM" steps. */
  vmName?: string;
  cpuCores?: number;
  memoryMb?: number;
  diskSizeGb?: number;

  /** Address Home Assistant was reached on, if it was found. */
  ipAddress?: string;

  /** UTM was found on the requirements step. */
  utmInstalled?: boolean;
  /** UTM install progress, so a retry resumes instead of starting over. */
  vmId?: string;
  /** Native creation outlives its view; reentry must await the same result. */
  utmCreation?: { config: UtmVmConfig; result: Promise<string> };
  /** A completed VM with superseded settings must not be silently recreated. */
  utmSupersededVmId?: string;

  /** Proxmox login, kept so going back to the connect step doesn't log in again. */
  proxmoxSession?: ProxmoxSession;
  proxmoxUsername?: string;
  /** Cleared when a connect field changes, so the session no longer applies. */
  proxmoxConnected?: boolean;
  /**
   * The server of a session that expired or whose certificate changed, so
   * reconnecting starts from it and notices a different certificate.
   */
  proxmoxPreviousServer?: {
    server_url: string;
    certificate_sha256?: string | null;
  };

  /** Proxmox target picked in the "Configure VM" step. */
  proxmoxNode?: string;
  proxmoxStorage?: string;
  proxmoxBridge?: string;
  /** The selected bridge was verified for the current node and session. */
  proxmoxBridgeReady?: boolean;
  proxmoxVlanTag?: number;
  proxmoxVmId?: number;
  /** Node, storage, and VLAN tag were verified by the current configure view. */
  proxmoxConfigureReady?: boolean;
  /** The current configure view found active import storage on the node. */
  proxmoxImportReady?: boolean;
  /** Storage this flow enabled Import on, per server origin, for the reminder. */
  proxmoxImportChanges?: { serverOrigin: string; storage: string }[];
  /** Set once the Proxmox VM exists, so a retry resumes instead of starting over. */
  proxmoxVmResult?: ProxmoxVmResult;
}

export interface WizardState {
  currentFlow: WizardFlow | null;
  currentStepIndex: number;
  steps: WizardStep[];
  selections: WizardSelections;
}

type WizardStateListener = (state: WizardState) => void;

const FLOW_STEPS: Record<WizardFlow, WizardStep[]> = {
  sbc: [
    { id: "device", title: localize("state.wizard_state.select_device") },
    { id: "drive", title: localize("state.wizard_state.select_drive") },
    { id: "wifi", title: localize("state.wizard_state.wifi") },
    { id: "confirm", title: localize("common.confirm") },
    { id: "flash", title: localize("common.install") },
    { id: "success", title: localize("common.done") },
  ],
  minipc: [
    { id: "method", title: localize("state.wizard_state.installation_method") },
    {
      id: "architecture",
      title: localize("state.wizard_state.select_architecture"),
    },
    { id: "drive", title: localize("state.wizard_state.select_drive") },
    { id: "wifi", title: localize("state.wizard_state.wifi") },
    { id: "confirm", title: localize("common.confirm") },
    { id: "flash", title: localize("common.install") },
    { id: "success", title: localize("common.done") },
  ],
  "ha-hardware": [
    { id: "device", title: localize("state.wizard_state.select_device") },
    { id: "drive", title: localize("state.wizard_state.select_drive") },
    { id: "wifi", title: localize("state.wizard_state.wifi") },
    { id: "confirm", title: localize("common.confirm") },
    { id: "flash", title: localize("common.install") },
    { id: "success", title: localize("common.done") },
  ],
  proxmox: [
    {
      id: "connection",
      title: localize("state.wizard_state.connect_to_proxmox"),
    },
    { id: "configure", title: localize("state.wizard_state.configure_vm") },
    { id: "confirm", title: localize("common.confirm") },
    { id: "install", title: localize("common.install") },
    { id: "success", title: localize("common.done") },
  ],
  vm: [
    { id: "check", title: localize("state.wizard_state.check_requirements") },
    { id: "configure", title: localize("state.wizard_state.configure_vm") },
    { id: "confirm", title: localize("common.confirm") },
    { id: "install", title: localize("common.install") },
    { id: "success", title: localize("common.done") },
  ],
};

/** The steps of `flow`. Wi-Fi is offered only for boards that have it. */
function stepsFor(
  flow: WizardFlow,
  selections: WizardSelections
): WizardStep[] {
  return FLOW_STEPS[flow].filter(
    (step) => step.id !== "wifi" || supportsWifi(selections.deviceConfig?.board)
  );
}

function createInitialState(): WizardState {
  return {
    currentFlow: null,
    currentStepIndex: 0,
    steps: [],
    selections: {},
  };
}

class WizardStateStore {
  private state: WizardState = createInitialState();
  private _flowGeneration = 0;
  private listeners: Set<WizardStateListener> = new Set();

  /** Identifies a flow across navigation and selection updates. */
  get flowGeneration(): number {
    return this._flowGeneration;
  }

  getState(): WizardState {
    return this.state;
  }

  subscribe(listener: WizardStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((listener) => listener(this.state));
  }

  startFlow(flow: WizardFlow) {
    this._flowGeneration++;
    this.state = {
      currentFlow: flow,
      currentStepIndex: 0,
      steps: stepsFor(flow, {}),
      selections: {},
    };
    this.notify();
  }

  nextStep() {
    if (this.state.currentStepIndex < this.state.steps.length - 1) {
      this.state = {
        ...this.state,
        currentStepIndex: this.state.currentStepIndex + 1,
        selections: { ...this.state.selections, deviceCatalogReady: false },
      };
      this.notify();
    }
  }

  previousStep() {
    if (this.state.currentStepIndex > 0) {
      this.state = {
        ...this.state,
        currentStepIndex: this.state.currentStepIndex - 1,
        selections: { ...this.state.selections, deviceCatalogReady: false },
      };
      this.notify();
    }
  }

  goToStep(index: number) {
    if (index >= 0 && index < this.state.steps.length) {
      this.state = {
        ...this.state,
        currentStepIndex: index,
        selections:
          index === this.state.currentStepIndex
            ? this.state.selections
            : { ...this.state.selections, deviceCatalogReady: false },
      };
      this.notify();
    }
  }

  setSelection<K extends keyof WizardSelections>(
    key: K,
    value: WizardSelections[K]
  ) {
    const selections = { ...this.state.selections, [key]: value };
    const { currentFlow, currentStepIndex } = this.state;
    if (key === "deviceConfig" && currentFlow) {
      // The board decides whether there is a Wi-Fi step; stay on the same step
      const current = this.state.steps[currentStepIndex]?.id;
      const steps = stepsFor(currentFlow, selections);
      const index = steps.findIndex((step) => step.id === current);
      this.state = {
        ...this.state,
        steps,
        currentStepIndex: index >= 0 ? index : currentStepIndex,
        selections,
      };
    } else {
      this.state = { ...this.state, selections };
    }
    this.notify();
  }

  reset() {
    this._flowGeneration++;
    this.state = createInitialState();
    this.notify();
  }

  get currentStep(): WizardStep | null {
    return this.state.steps[this.state.currentStepIndex] || null;
  }

  get isFirstStep(): boolean {
    return this.state.currentStepIndex === 0;
  }

  get isLastStep(): boolean {
    return this.state.currentStepIndex === this.state.steps.length - 1;
  }

  get progress(): number {
    if (this.state.steps.length === 0) return 0;
    return (this.state.currentStepIndex + 1) / this.state.steps.length;
  }
}

// Singleton instance
export const wizardState = new WizardStateStore();
