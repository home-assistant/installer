import { html, type TemplateResult } from "lit";
import { localize } from "../localization/localize.js";
import { isValidUtmVmName } from "../state/vm-defaults.js";
import type { WizardFlow, WizardSelections } from "../state/wizard-state.js";
import { isValidWifi, selectedWifi } from "../utils/wifi.js";
import { isYellow } from "../views/ha-hardware/hardware.js";
import type { HaHardwareDeviceSelectionView } from "../views/ha-hardware/device-selection-view.js";
import type { LiveIsoLocationView } from "../views/live-usb/live-iso-location-view.js";
import type { ProxmoxConfigureView } from "../views/proxmox/proxmox-configure-view.js";
import type { ProxmoxConnectView } from "../views/proxmox/proxmox-connect-view.js";

/** What the shell can ask of the step it shows; a step offers what it has. */
export interface WizardStepView extends HTMLElement {
  /** Run the step's failed install again */
  retry?(): void;
  /** Stop the step's running install, if it still can */
  stop?(): void;
}

/** Work that has to succeed before Next leaves the step, like logging in. */
interface BeforeNext {
  run(view: WizardStepView): Promise<boolean>;
  /**
   * Shown and announced on Next meanwhile, which waits with a spinner.
   * Without one, Next stays as it is: a question the step asks in a dialog
   * says enough.
   */
  label?(): string;
  /**
   * What makes a result stale, so a run left behind holds up nothing:
   * leaving the flow, or also changing any selection.
   */
  until: "flow" | "selections";
}

/** A step Next leads to from a failed install, instead of trying it again. */
export interface InstallDetour {
  step: string;
  /** What Next says */
  label: string;
}

/**
 * A step whose view runs an install, and what the shell offers around it.
 * The view tells the shell how the install goes with the `install-*` events.
 */
export interface InstallStep {
  /** What "Stop the installation?" says a stop leaves behind */
  stopMessage(selections: WizardSelections): string;
  /**
   * Once the install failed or was stopped, Back returns to the step
   * before, to change a choice and install again. Without it, Back stays
   * hidden.
   */
  backAfterError?: boolean;
  /**
   * Where a failure that trying again can't fix leads, like a drive that is
   * gone. Without it, Cancel is all that is left.
   */
  changeChoice?(selections: WizardSelections): InstallDetour;
  /** Where a failure that logging in again fixes leads */
  reconnect?(): InstallDetour;
}

export interface WizardStepDefinition {
  render(): TemplateResult;
  /** Whether Next can be pressed yet; always, without it */
  ready?(selections: WizardSelections): boolean;
  beforeNext?: BeforeNext;
  /** A later step Next goes to instead of the following one, if any */
  skipTo?(selections: WizardSelections): string | undefined;
  /** What Next says, if not "Next" */
  nextLabel?(): string;
  /** Picking an option moves on by itself, so there is no Next */
  pickToContinue?: boolean;
  /** Whether Next erases the drive, which is checked and asked first */
  erasesDrive?(selections: WizardSelections): boolean;
  /** The step's view runs an install, which the shell can stop and retry */
  install?: InstallStep;
}

const deviceChosen = (selections: WizardSelections) =>
  !!selections.deviceCatalogReady && !!selections.device;

const drive: WizardStepDefinition = {
  render: () => html`<drive-selection-view></drive-selection-view>`,
  // A drive picked earlier may be gone by now, so wait for the scan
  ready: (selections) => !!selections.driveScanReady && !!selections.drive,
};

const wifi: WizardStepDefinition = {
  render: () => html`<wifi-view></wifi-view>`,
  ready: (selections) => {
    const wifi = selectedWifi(selections);
    return wifi === undefined || isValidWifi(wifi);
  },
};

const confirmation: WizardStepDefinition = {
  render: () => html`<confirmation-view></confirmation-view>`,
  nextLabel: () => localize("common.install"),
  erasesDrive: () => true,
};

const chooseAnotherDrive = (): InstallDetour => ({
  step: "drive",
  label: localize("components.wizard_steps.choose_another_drive"),
});

/** Writing the drive, which can go back to change it or the Wi-Fi */
const flash: WizardStepDefinition = {
  render: () => html`<progress-view></progress-view>`,
  install: {
    stopMessage: () =>
      localize("components.wizard_steps.stop_installation_message"),
    backAfterError: true,
    changeChoice: chooseAnotherDrive,
  },
};

/** Making and starting a VM, which can't take other settings once made */
const vmInstall: InstallStep = {
  stopMessage: () =>
    localize("components.wizard_steps.stop_vm_installation_message"),
};

/** The view of every step of every flow, and what it takes to leave it. */
export const WIZARD_STEPS: Record<
  WizardFlow,
  Record<string, WizardStepDefinition>
> = {
  sbc: {
    device: {
      render: () => html`<device-selection-view></device-selection-view>`,
      ready: deviceChosen,
    },
    drive,
    wifi,
    confirm: confirmation,
    flash,
    success: { render: () => html`<success-view></success-view>` },
  },
  // The SBC steps, with its own device picker and device-specific next steps
  "ha-hardware": {
    device: {
      render: () =>
        html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`,
      ready: deviceChosen,
      // The hardware ships with Home Assistant, so reinstalling is the exception
      beforeNext: {
        run: (view) =>
          (view as HaHardwareDeviceSelectionView).confirmReinstall(),
        until: "flow",
      },
    },
    // Only for the Yellow, which has a CM4 or CM5 inside
    module: {
      render: () =>
        html`<ha-hardware-module-selection-view></ha-hardware-module-selection-view>`,
      ready: (selections) =>
        isYellow(selections.haHardware) && !!selections.deviceConfig,
    },
    drive,
    wifi,
    confirm: confirmation,
    flash,
    success: {
      render: () => html`<ha-hardware-success-view></ha-hardware-success-view>`,
    },
  },
  minipc: {
    method: {
      render: () => html`<minipc-setup-method-view></minipc-setup-method-view>`,
      pickToContinue: true,
    },
    architecture: {
      render: () =>
        html`<minipc-architecture-selection-view></minipc-architecture-selection-view>`,
      ready: deviceChosen,
    },
    drive,
    wifi,
    confirm: confirmation,
    flash,
    success: { render: () => html`<success-view></success-view>` },
  },
  vm: {
    check: {
      render: () => html`<utm-check-view></utm-check-view>`,
      ready: (selections) => !!selections.utmInstalled,
    },
    configure: {
      render: () => html`<utm-configure-view></utm-configure-view>`,
      // The name is kept as typed, so a cleared one holds Next back. Until
      // the view first saves there is none, and the default name applies.
      ready: (selections) =>
        selections.vmName === undefined || isValidUtmVmName(selections.vmName),
    },
    confirm: {
      render: () => html`<utm-confirm-view></utm-confirm-view>`,
      nextLabel: () => localize("common.install"),
    },
    install: {
      render: () => html`<utm-progress-view></utm-progress-view>`,
      install: vmInstall,
    },
    success: { render: () => html`<utm-success-view></utm-success-view>` },
  },
  proxmox: {
    connection: {
      render: () => html`<proxmox-connect-view></proxmox-connect-view>`,
      beforeNext: {
        run: (view) => (view as ProxmoxConnectView).connect(),
        label: () => localize("components.wizard_steps.connecting"),
        // Connecting stores the session, which changes the selections
        until: "flow",
      },
      // Back to log in again after the session expired during the install.
      // A VM made by then can't take new settings, and checking them would
      // only find its VM ID taken: go on waiting for it instead.
      skipTo: (selections) =>
        selections.proxmoxVmResult ? "install" : undefined,
    },
    configure: {
      render: () => html`<proxmox-configure-view></proxmox-configure-view>`,
      ready: (selections) =>
        !!selections.proxmoxConfigureReady &&
        !!selections.proxmoxNode &&
        !!selections.proxmoxStorage &&
        !!selections.proxmoxBridge &&
        !!selections.proxmoxBridgeReady &&
        !!selections.proxmoxImportReady,
      // A problem Proxmox finds now can still be fixed on this step
      beforeNext: {
        run: (view) => (view as ProxmoxConfigureView).check(),
        label: () => localize("components.wizard_steps.checking_settings"),
        until: "selections",
      },
    },
    confirm: {
      render: () => html`<proxmox-confirm-view></proxmox-confirm-view>`,
      nextLabel: () => localize("common.install"),
    },
    install: {
      render: () => html`<proxmox-progress-view></proxmox-progress-view>`,
      install: {
        ...vmInstall,
        // The session expired: log in again, then wait for the VM made by then
        reconnect: () => ({
          step: "connection",
          label: localize("proxmox.reconnect"),
        }),
      },
    },
    success: {
      render: () => html`<proxmox-success-view></proxmox-success-view>`,
    },
  },
};

/** Whether the USB path saves an ISO file, rather than writing a stick */
const isoFile = (selections: WizardSelections) =>
  selections.liveMedia === "iso";

/** The Mini PC steps after choosing to boot from USB, where they differ. */
export const LIVE_USB_STEPS: Record<string, WizardStepDefinition> = {
  media: {
    render: () => html`<minipc-media-view></minipc-media-view>`,
    pickToContinue: true,
  },
  drive: {
    render: () =>
      html`<live-usb-gate admin
        ><drive-selection-view></drive-selection-view
      ></live-usb-gate>`,
    ready: (selections) => drive.ready!(selections) && !!selections.liveReady,
  },
  location: {
    render: () => html`<live-iso-location-view></live-iso-location-view>`,
    ready: (selections) =>
      !!selections.liveReady &&
      !!selections.liveIsoFolder?.trim() &&
      !!selections.liveIsoName,
    // Problems with the folder can still be fixed before the download
    beforeNext: {
      run: (view) => (view as LiveIsoLocationView).check(),
      label: () => localize("components.wizard_steps.checking_location"),
      until: "selections",
    },
  },
  confirm: {
    render: () => html`<live-usb-summary-view></live-usb-summary-view>`,
    nextLabel: () => localize("common.create"),
    // Saving an ISO erases nothing
    erasesDrive: (selections) => !isoFile(selections),
  },
  flash: {
    render: () => html`<live-usb-progress-view></live-usb-progress-view>`,
    install: {
      stopMessage: (selections) =>
        isoFile(selections)
          ? localize("components.wizard_steps.stop_iso_message")
          : localize("components.wizard_steps.stop_installation_message"),
      backAfterError: true,
      // The ISO has a save location where the stick has a drive
      changeChoice: (selections) =>
        isoFile(selections)
          ? {
              step: "location",
              label: localize(
                "components.wizard_steps.choose_another_location"
              ),
            }
          : chooseAnotherDrive(),
    },
  },
  success: {
    render: () => html`<live-usb-success-view></live-usb-success-view>`,
  },
};

export function wizardStep(
  flow: WizardFlow | null,
  stepId: string | undefined,
  selections?: WizardSelections
): WizardStepDefinition | undefined {
  if (!flow || !stepId) return undefined;
  if (flow === "minipc" && selections?.installMethod === "usb-boot") {
    return LIVE_USB_STEPS[stepId] ?? WIZARD_STEPS.minipc[stepId];
  }
  return WIZARD_STEPS[flow][stepId];
}
