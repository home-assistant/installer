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
import type {
  HaHardwareId,
  YellowModuleId,
} from "../views/ha-hardware/hardware.js";
import { supportsWifi } from "../utils/wifi.js";

export type WizardFlow = InstallationPath;

export interface WizardStep {
  id: string;
  title: string;
  /** Whether the flow has this step for these selections; always, without it */
  when?(selections: WizardSelections): boolean;
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
  /** The Yellow's compute modules the catalog offers, each with its storage config. */
  yellowModules?: { id: YellowModuleId; config: HaosConfig }[];
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
  /** The current drive picker has scanned, so a drive it kept is connected. */
  driveScanReady?: boolean;
  /**
   * The drive was cleared because the install couldn't confirm it, so the
   * drive step explains why.
   */
  driveSelectionLost?: boolean;
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

  /** Mini PC path: connect the drive here, or boot the mini PC from USB. */
  installMethod?: "direct" | "usb-boot";
  /** Bootable media to create for the USB boot path. */
  liveMedia?: "usb" | "iso";
  /** The live USB checks passed (hai-live found, admin rights where needed). */
  liveReady?: boolean;
  /** Where the ISO is saved: folder and file name as entered, then the saved path. */
  liveIsoFolder?: string;
  liveIsoName?: string;
  /** The user agreed to replace an existing file with that name. */
  liveIsoOverwrite?: boolean;
  liveIsoPath?: string;
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

/**
 * A step whose title is looked up each time it is read, so it follows the
 * language. The step itself is built once and stays the same object, which
 * the step indicator relies on to keep its steps between selection changes.
 */
function localizedStep(
  id: string,
  title: () => string,
  when?: WizardStep["when"]
): WizardStep {
  return {
    id,
    get title() {
      return title();
    },
    when,
  };
}

/** Wi-Fi is offered only for boards that have it. */
const wifiStep = localizedStep(
  "wifi",
  () => localize("state.wizard_state.wifi"),
  (selections) => supportsWifi(selections.deviceConfig?.board)
);

const FLOW_STEPS: Record<WizardFlow, WizardStep[]> = {
  sbc: [
    localizedStep("device", () => localize("state.wizard_state.select_device")),
    localizedStep("drive", () => localize("state.wizard_state.select_drive")),
    wifiStep,
    localizedStep("confirm", () => localize("common.confirm")),
    localizedStep("flash", () => localize("common.install")),
    localizedStep("success", () => localize("common.done")),
  ],
  minipc: [
    localizedStep("method", () =>
      localize("state.wizard_state.installation_method")
    ),
    localizedStep("architecture", () =>
      localize("state.wizard_state.select_processor")
    ),
    localizedStep("drive", () => localize("state.wizard_state.select_drive")),
    wifiStep,
    localizedStep("confirm", () => localize("common.confirm")),
    localizedStep("flash", () => localize("common.install")),
    localizedStep("success", () => localize("common.done")),
  ],
  "ha-hardware": [
    localizedStep("device", () => localize("state.wizard_state.select_device")),
    // Only for the Yellow, whose compute modules the device step hands on
    localizedStep(
      "module",
      () => localize("state.wizard_state.select_module"),
      (selections) => !!selections.yellowModules?.length
    ),
    localizedStep("drive", () => localize("state.wizard_state.select_drive")),
    wifiStep,
    localizedStep("confirm", () => localize("common.confirm")),
    localizedStep("flash", () => localize("common.install")),
    localizedStep("success", () => localize("common.done")),
  ],
  proxmox: [
    localizedStep("connection", () =>
      localize("state.wizard_state.connect_to_proxmox")
    ),
    localizedStep("configure", () =>
      localize("state.wizard_state.configure_vm")
    ),
    localizedStep("confirm", () => localize("common.confirm")),
    localizedStep("install", () => localize("common.install")),
    localizedStep("success", () => localize("common.done")),
  ],
  vm: [
    localizedStep("check", () =>
      localize("state.wizard_state.check_requirements")
    ),
    localizedStep("configure", () =>
      localize("state.wizard_state.configure_vm")
    ),
    localizedStep("confirm", () => localize("common.confirm")),
    localizedStep("install", () => localize("common.install")),
    localizedStep("success", () => localize("common.done")),
  ],
};

/** The steps of `flow` that apply to `selections`. */
function stepsFor(
  flow: WizardFlow,
  selections: WizardSelections
): WizardStep[] {
  // Booting the mini PC from USB has steps of its own. Steps follow the
  // selections, so this keeps them when a later selection changes.
  if (flow === "minipc" && selections.installMethod === "usb-boot") {
    return MINIPC_STEPS[selections.liveMedia ?? "usb"];
  }

  return FLOW_STEPS[flow].filter((step) => step.when?.(selections) ?? true);
}

/** The USB path keeps the drive/confirm/flash/success ids, so the shell's drive
 * re-checks, erase confirmation and retry handling apply to it unchanged. */
function liveUsbSteps(target: WizardStep): WizardStep[] {
  return [
    localizedStep("method", () =>
      localize("state.wizard_state.installation_method")
    ),
    localizedStep("media", () => localize("state.wizard_state.media_type")),
    target,
    localizedStep("confirm", () => localize("common.confirm")),
    localizedStep("flash", () => localize("common.create")),
    localizedStep("success", () => localize("common.done")),
  ];
}

/** Mini PC paths share the method step, then each shows its own steps. */
export const MINIPC_STEPS = {
  // No board is picked yet; choosing one adds the Wi-Fi step back.
  direct: stepsFor("minipc", {}),
  usb: liveUsbSteps(
    localizedStep("drive", () =>
      localize("state.wizard_state.select_usb_stick")
    )
  ),
  iso: liveUsbSteps(
    localizedStep("location", () =>
      localize("state.wizard_state.save_location")
    )
  ),
};

/** The direct path's steps, with Wi-Fi if the architecture picked earlier has it. */
export function minipcDirectSteps(selections: WizardSelections): WizardStep[] {
  // Without a picked architecture, deviceConfig may still be the USB path's
  return stepsFor("minipc", selections.device ? selections : {});
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
        selections: {
          ...this.state.selections,
          deviceCatalogReady: false,
          driveScanReady: false,
        },
      };
      this.notify();
    }
  }

  previousStep() {
    if (this.state.currentStepIndex > 0) {
      this.state = {
        ...this.state,
        currentStepIndex: this.state.currentStepIndex - 1,
        selections: {
          ...this.state.selections,
          deviceCatalogReady: false,
          driveScanReady: false,
        },
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
            : {
                ...this.state.selections,
                deviceCatalogReady: false,
                driveScanReady: false,
              },
      };
      this.notify();
    }
  }

  setSelection<K extends keyof WizardSelections>(
    key: K,
    value: WizardSelections[K]
  ) {
    this.setSelections({ [key]: value });
  }

  /**
   * Set several selections at once, so subscribers hear of them once.
   *
   * State is never changed in place, so values are compared by identity. A
   * write that changes nothing keeps the same `selections` object and
   * notifies no one, so a check that compares selections by identity to
   * notice a change while it ran still applies.
   */
  setSelections(changes: Partial<WizardSelections>) {
    const previous = this.state.selections;
    const keys = Object.keys(changes) as (keyof WizardSelections)[];
    if (keys.every((key) => Object.is(previous[key], changes[key]))) return;
    const selections = { ...previous, ...changes };
    const { currentFlow, currentStepIndex, steps } = this.state;
    // Selections decide which steps the flow has; stay on the same step. The
    // same steps stay the same array, so the step indicator keeps them.
    const next = currentFlow ? stepsFor(currentFlow, selections) : steps;
    const changed =
      next.length !== steps.length ||
      next.some((step, index) => step !== steps[index]);
    const index = next.findIndex(
      (step) => step.id === steps[currentStepIndex]?.id
    );
    this.state = {
      ...this.state,
      steps: changed ? next : steps,
      currentStepIndex: index >= 0 ? index : currentStepIndex,
      selections,
    };
    this.notify();
  }

  /** Replaces the step list when a choice splits the flow; keeps the position. */
  setSteps(steps: WizardStep[]) {
    this.state = {
      ...this.state,
      steps,
      currentStepIndex: Math.min(this.state.currentStepIndex, steps.length - 1),
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
