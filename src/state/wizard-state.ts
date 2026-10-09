import { localize } from "../localization/localize.js";
import type {
  HaosConfig,
  ProxmoxSession,
  ProxmoxVmResult,
  UtmVmConfig,
} from "../api/types.js";
import type { InstallationPath } from "../views/path-selection-view.js";

export type WizardFlow = InstallationPath;

export interface WizardStep {
  id: string;
  title: string;
}

/**
 * Values collected while stepping through a flow.
 *
 * The index signature keeps this open for the keys that are not declared yet;
 * the declared keys are the ones the VM flows read back (a configure step that
 * re-reads what the user picked, an install step that resumes where it left
 * off) and so need to agree on name and type across views.
 */
export interface WizardSelections {
  device?: string;
  /** The current device picker has successfully refreshed board availability. */
  deviceCatalogReady?: boolean;
  /** HAOS image of the selected device; its board picks the image to flash. */
  deviceConfig?: HaosConfig;
  /** Device id of the selected drive; also the path sent to the backend. */
  drive?: string;
  /** Rest of the selected drive's identity, kept so it can be re-verified. */
  driveName?: string;
  driveSize?: number;
  driveModel?: string;
  driveVendor?: string;
  driveSerial?: string;

  /** VM configuration, shared by the UTM and Proxmox "Configure VM" steps. */
  vmName?: string;
  cpuCores?: number;
  memoryMb?: number;
  diskSizeGb?: number;

  /** Address Home Assistant was reached on, if it was found. */
  ipAddress?: string;

  /** UTM install progress, so a retry resumes instead of starting over. */
  vmId?: string;
  /** Native creation outlives its view; reentry must await the same result. */
  utmCreation?: { config: UtmVmConfig; result: Promise<string> };
  /** A completed VM with superseded settings must not be silently recreated. */
  utmSupersededVmId?: string;
  /** Set once the disk of the VM in `vmId` has been resized. */
  utmDiskResized?: boolean;

  /** Proxmox login, kept so going back to the connect step doesn't log in again. */
  proxmoxSession?: ProxmoxSession;
  proxmoxUsername?: string;
  /** Cleared when a connect field changes, so the session no longer applies. */
  proxmoxConnected?: boolean;

  /** Proxmox target picked in the "Configure VM" step. */
  proxmoxNode?: string;
  proxmoxStorage?: string;
  proxmoxBridge?: string;
  /** The selected bridge was verified for the current node and session. */
  proxmoxBridgeReady?: boolean;
  proxmoxVmId?: number;
  /** Node and storage selections were verified by the current configure view. */
  proxmoxConfigureReady?: boolean;
  /** Set once the Proxmox VM exists, so a retry resumes instead of starting over. */
  proxmoxVmResult?: ProxmoxVmResult;

  [key: string]: unknown;
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
    { id: "confirm", title: localize("common.confirm") },
    { id: "flash", title: localize("common.install") },
    { id: "success", title: localize("common.done") },
  ],
  "ha-hardware": [
    { id: "device", title: localize("state.wizard_state.select_device") },
    { id: "connect", title: localize("state.wizard_state.connect") },
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
      steps: FLOW_STEPS[flow] || [],
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
    this.state = {
      ...this.state,
      selections: {
        ...this.state.selections,
        [key]: value,
      },
    };
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
