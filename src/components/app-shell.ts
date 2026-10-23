import { localize } from "../localization/localize.js";
import { LitElement, html, css, nothing } from "lit";
import { customElement, query, state } from "lit/decorators.js";

// Import views
import "../views/welcome-view.js";
import "../views/connection-check-view.js";
import "../views/path-selection-view.js";
import "../views/other-options-view.js";
import "../views/sbc/device-selection-view.js";
import "../views/sbc/drive-selection-view.js";
import "../views/sbc/confirmation-view.js";
import "../views/sbc/wifi-view.js";
import "../views/sbc/progress-view.js";
import "../views/sbc/success-view.js";
import "../views/ha-hardware/device-selection-view.js";
import "../views/ha-hardware/module-selection-view.js";
import "../views/ha-hardware/success-view.js";
import "../views/minipc/setup-method-view.js";
import "../views/minipc/architecture-selection-view.js";
import "../views/minipc/media-view.js";
import "../views/live-usb/live-usb-gate.js";
import "../views/live-usb/live-iso-location-view.js";
import "../views/live-usb/live-usb-summary-view.js";
import "../views/live-usb/live-usb-progress-view.js";
import "../views/live-usb/live-usb-success-view.js";
import "../views/utm/utm-check-view.js";
import "../views/utm/utm-configure-view.js";
import "../views/utm/utm-confirm-view.js";
import "../views/utm/utm-progress-view.js";
import "../views/utm/utm-success-view.js";
import "../views/proxmox/proxmox-connect-view.js";
import "../views/proxmox/proxmox-configure-view.js";
import "../views/proxmox/proxmox-confirm-view.js";
import "../views/proxmox/proxmox-progress-view.js";
import "../views/proxmox/proxmox-success-view.js";
import { enabledImportStorageList } from "../views/proxmox/proxmox-success-view.js";

// Import components
import type { WizardShell } from "./wizard-shell.js";
import "./wizard-shell.js";
import {
  wizardStep,
  type InstallDetour,
  type InstallStep,
  type WizardStepDefinition,
  type WizardStepView,
} from "./wizard-steps.js";
import type { ConfirmDialog } from "./confirm-dialog.js";
import "./confirm-dialog.js";
import "./info-dialog.js";

// Import state
import {
  wizardState,
  type WizardFlow,
  type WizardState,
} from "../state/wizard-state.js";
import { listBlockDevices, onCloseBlocked, quitAnyway } from "../api/index.js";
import {
  clearDriveSelection,
  findDrive,
  readDriveSelection,
} from "../utils/drive-selection.js";
import { logFrontendError } from "../utils/diagnostics.js";

export type ViewName =
  | "welcome"
  | "path-selection"
  | "other-options"
  | "connection-check"
  | "wizard";

@customElement("app-shell")
export class AppShell extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100vh;
      background-color: var(--ha-background-color, #ffffff);
      position: relative;
    }

    :host > * {
      flex: 1;
    }
  `;

  @state()
  private _currentView: ViewName = "welcome";

  @state()
  private _wizardState: WizardState = wizardState.getState();

  @state()
  private _showConfirmDialog = false;

  /** The install of the step on screen failed, or was stopped */
  @state()
  private _installError = false;

  @state()
  private _installRetryable = false;

  /** The failed install needs a new Proxmox login before it can go on */
  @state()
  private _installReconnect = false;

  // What the running `beforeNext` of a step started from: the flow, or the
  // selections. Leaving the flow (or changing a choice) replaces it, so a run
  // left behind holds up nothing.
  @state()
  private _pendingNext?: unknown;

  @state()
  private _verifyingDrive = false;

  @state()
  private _showStopDialog = false;

  /** What the open "Stop the installation?" says a stop leaves behind */
  @state()
  private _stopMessage = "";

  /** Asks before leaving an install that can no longer stop */
  @state()
  private _showLeaveDialog = false;

  /** Whether the running install can still stop; until it says, it can */
  @state()
  private _installStoppable = true;

  /** Whether the running install can be left to finish on its own */
  @state()
  private _installLeavable = false;

  @state()
  private _showQuitDialog = false;

  @query("wizard-shell")
  private _wizardShell?: WizardShell;

  @query("confirm-dialog")
  private _confirmDialog?: ConfirmDialog;

  private _unsubscribe?: () => void;
  private _stopCloseListener?: Promise<() => void>;
  private _pendingFlow?: WizardFlow;

  /** The screen the latest single click landed on. */
  private _clickedScreen?: string;

  connectedCallback() {
    super.connectedCallback();
    // Capturing, so it runs before the controls on the screen
    this.addEventListener("click", this._onClick, true);
    this._unsubscribe = wizardState.subscribe((state) => {
      this._wizardState = state;
    });
    // The backend holds back closing the app while an installation runs
    this._stopCloseListener = onCloseBlocked(() => {
      // One question at a time: quitting is the bigger one
      this._showStopDialog = false;
      this._showLeaveDialog = false;
      this._showQuitDialog = true;
    }).catch((error: unknown) => {
      logFrontendError(error);
      return () => {};
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("click", this._onClick, true);
    this._unsubscribe?.();
    void this._stopCloseListener?.then((stop) => stop());
  }

  render() {
    const selections = this._wizardState.selections;
    const address = selections.ipAddress
      ? `http://${selections.ipAddress}`
      : "http://homeassistant.local";
    // Leaving skips the success view, which reminds of the Import this flow
    // enabled
    const importStorages = enabledImportStorageList(selections);

    return html`
      ${this._renderView()}
      <confirm-dialog
        ?open=${this._showConfirmDialog}
        .driveName=${selections.driveName || ""}
        .drivePath=${selections.drive || ""}
        .driveModel=${[selections.driveVendor, selections.driveModel]
          .filter(Boolean)
          .join(" ")}
        .driveSize=${selections.driveSize}
        @dialog-cancel=${this._onDialogCancel}
        @dialog-confirm=${this._onDialogConfirm}
      ></confirm-dialog>
      <info-dialog
        class="stop-dialog"
        ?open=${this._showStopDialog}
        .heading=${localize("components.app_shell.stop_installation_title")}
        .message=${this._stopMessage}
        .primaryLabel=${localize("components.app_shell.stop_installation")}
        .secondaryLabel=${localize("components.app_shell.keep_installing")}
        primary-variant="danger"
        @dialog-primary=${this._onStopInstallation}
        @dialog-secondary=${this._onKeepInstalling}
      ></info-dialog>
      <info-dialog
        class="leave-dialog"
        ?open=${this._showLeaveDialog}
        .heading=${localize("components.app_shell.leave_installation_title")}
        .message=${importStorages
          ? localize("components.app_shell.leave_installation_import_message", {
              address,
              storages: importStorages,
            })
          : localize("components.app_shell.leave_installation_message", {
              address,
            })}
        .primaryLabel=${localize("components.app_shell.leave_installation")}
        .secondaryLabel=${localize("components.app_shell.keep_waiting")}
        @dialog-primary=${this._onLeaveInstallation}
        @dialog-secondary=${this._onKeepWaiting}
      ></info-dialog>
      <info-dialog
        class="quit-dialog"
        ?open=${this._showQuitDialog}
        .heading=${localize("components.app_shell.quit_while_installing_title")}
        .message=${localize(
          "components.app_shell.quit_while_installing_message"
        )}
        .primaryLabel=${localize("components.app_shell.quit_anyway")}
        .secondaryLabel=${localize("components.app_shell.keep_installing")}
        primary-variant="danger"
        @dialog-primary=${this._onQuitAnyway}
        @dialog-secondary=${this._onKeepInstallingOnQuit}
      ></info-dialog>
    `;
  }

  private _renderView() {
    switch (this._currentView) {
      case "connection-check":
        return html`<connection-check-view
          @connection-ready=${this._onConnectionReady}
          @connection-back=${this._onConnectionBack}
        ></connection-check-view>`;
      case "welcome":
        return html`<welcome-view
          @navigate=${this._onNavigate}
        ></welcome-view>`;
      case "path-selection":
        return html`<path-selection-view
          @navigate=${this._onNavigate}
          @select-path=${this._onSelectPath}
        ></path-selection-view>`;
      case "other-options":
        return html`<other-options-view
          @navigate=${this._onNavigate}
        ></other-options-view>`;
      case "wizard":
        return this._renderWizard();
      default:
        return html`<welcome-view
          @navigate=${this._onNavigate}
        ></welcome-view>`;
    }
  }

  private _renderWizard() {
    const step = this._step;
    const install = step?.install;
    const nextDisabled = !this._isReady(step);
    const nextLabel = this._getNextLabel(step);
    // What Next waits for. It says so and keeps the focus: disabled, it
    // would drop the focus to the page
    const busy = this._isBusy(step)
      ? step?.beforeNext?.label?.()
      : this._verifyingDrive
        ? localize("components.app_shell.checking_drive")
        : undefined;

    // A running install keeps only Cancel, while it can stop or be left.
    // Once a VM runs, waiting for Home Assistant can take an hour, and
    // leaving no longer leaves anything half done.
    const running = this._installRunning;
    const hideFooter =
      running && !this._installStoppable && !this._installLeavable;

    // Back from an install only once it failed or was stopped, where a choice
    // can still change. The flow ends on its last step.
    const last = wizardState.isLastStep;
    const hideBack =
      last || (!!install && (running || !install.backAfterError));

    // Done already returns to the start, so Cancel would only repeat it
    const hideCancel = last;

    const hideNext =
      running ||
      !!step?.pickToContinue ||
      (!!install && this._installError && this._installStuck(install));

    return html`
      <wizard-shell
        .nextDisabled=${nextDisabled}
        .nextBusy=${!!busy}
        .nextLabel=${busy ?? nextLabel}
        .hideFooter=${hideFooter}
        .hideBack=${hideBack}
        .hideNext=${hideNext}
        .hideCancel=${hideCancel}
        @wizard-cancel=${this._onWizardCancel}
        @wizard-back=${this._onWizardBack}
        @wizard-exit=${this._onWizardExit}
        @wizard-next=${this._onWizardNext}
        @install-stoppable=${this._onInstallStoppable}
        @install-leavable=${this._onInstallLeavable}
        @install-complete=${this._onInstallComplete}
        @install-error=${this._onInstallError}
      >
        ${step?.render() ?? nothing}
      </wizard-shell>
    `;
  }

  private _getNextLabel(step: WizardStepDefinition | undefined): string {
    if (step?.install && this._installError) {
      return (
        this._installDetour(step.install)?.label ?? localize("common.try_again")
      );
    }
    if (wizardState.isLastStep) {
      return localize("common.done");
    }
    return step?.nextLabel?.() ?? localize("common.next");
  }

  private _isReady(step: WizardStepDefinition | undefined): boolean {
    return step?.ready?.(wizardState.getState().selections) ?? true;
  }

  /** What a `beforeNext` run of `step` started now would be held by. */
  private _pendingToken(step: WizardStepDefinition): unknown {
    return step.beforeNext?.until === "flow"
      ? wizardState.flowGeneration
      : wizardState.getState().selections;
  }

  private _isBusy(step: WizardStepDefinition | undefined): boolean {
    return (
      !!step?.beforeNext &&
      this._pendingNext !== undefined &&
      this._pendingNext === this._pendingToken(step)
    );
  }

  /** The definition of the step on screen. */
  private get _step(): WizardStepDefinition | undefined {
    return wizardStep(
      this._wizardState.currentFlow,
      wizardState.currentStep?.id,
      this._wizardState.selections
    );
  }

  /** The view of the current step, the wizard shell's only child. */
  private get _stepView(): WizardStepView | null {
    return (this._wizardShell?.firstElementChild ??
      null) as WizardStepView | null;
  }

  /** What is on screen: the view, and in the wizard, its step. */
  private get _screen(): string {
    return this._currentView === "wizard"
      ? `wizard/${wizardState.currentStep?.id}`
      : this._currentView;
  }

  // A click that changes the screen does so before the second click of a
  // double-click arrives, so that one would act on whatever the next screen
  // has in the same spot: Back on the first step and then Back on the path
  // selection went all the way to the welcome screen, and Next on a
  // configured VM went past its confirmation into the install. `detail`
  // counts the clicks; keyboard activation reports 0.
  private _onClick = (event: MouseEvent) => {
    if (event.detail < 2) {
      this._clickedScreen = this._screen;
    } else if (this._screen !== this._clickedScreen) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private _onNavigate(e: CustomEvent<{ view: ViewName }>) {
    this._currentView = e.detail.view;
  }

  private _onSelectPath(e: CustomEvent<{ path: WizardFlow }>) {
    this._resetErrorState();
    this._pendingFlow = e.detail.path;
    this._currentView = "connection-check";
  }

  private _onConnectionReady() {
    if (this._currentView !== "connection-check" || !this._pendingFlow) return;
    wizardState.startFlow(this._pendingFlow);
    this._pendingFlow = undefined;
    this._currentView = "wizard";
  }

  private _onConnectionBack() {
    this._pendingFlow = undefined;
    this._currentView = "path-selection";
  }

  private _onWizardCancel() {
    // A running install is stopped or left first, never just dropped
    if (this._installRunning) {
      if (this._installStoppable) {
        this._stopMessage =
          this._step?.install?.stopMessage(this._wizardState.selections) ?? "";
        this._showStopDialog = true;
      } else if (this._installLeavable) {
        this._showLeaveDialog = true;
      }
      // Otherwise Cancel showed, but the install moved on past where it can
      // stop, like to creating the VM
      return;
    }

    this._resetErrorState();
    wizardState.reset();
    this._currentView = "welcome";
  }

  /**
   * Back from a failed or stopped install leaves its error behind. Install
   * on the confirmation then checks the drive and asks before erasing it
   * again.
   */
  private _onWizardBack() {
    this._resetErrorState();
  }

  /** Back on the first step returns to where the flow was picked. */
  private _onWizardExit() {
    this._resetErrorState();
    wizardState.reset();
    this._currentView = "path-selection";
  }

  /** Stale flags would show "Try again", or no Cancel, over the next install. */
  private _resetErrorState() {
    this._installStoppable = true;
    this._installLeavable = false;
    this._installError = false;
    this._installRetryable = false;
    this._installReconnect = false;
  }

  /** Whether the step on screen runs an install that has not failed. */
  private get _installRunning(): boolean {
    return !!this._step?.install && !this._installError;
  }

  /**
   * Where Next leads from the failed `install` instead of trying it again:
   * to log in again, or to change a choice that trying again can't fix.
   */
  private _installDetour(install: InstallStep): InstallDetour | undefined {
    if (this._installReconnect) return install.reconnect?.();
    if (this._installRetryable) return undefined;
    return install.changeChoice?.(this._wizardState.selections);
  }

  /** Whether the failed install can neither be tried again nor resumed. */
  private _installStuck(install: InstallStep): boolean {
    return !this._installRetryable && !this._installDetour(install);
  }

  private async _onWizardNext() {
    const step = this._step;

    if (step?.install && this._installError) {
      const detour = this._installDetour(step.install);
      if (detour) {
        // Log in again and carry on, or change the choice that failed
        this._resetErrorState();
        this._goToStep(detour.step);
      } else if (this._installRetryable) {
        this._installError = false;
        this._stepView?.retry?.();
      }
      // Otherwise Next is hidden: there is nothing to try again
      return;
    }

    if (step?.beforeNext) {
      // Next takes no clicks while it isn't ready or is busy, but the step
      // must never proceed meanwhile, whatever triggered the event
      const view = this._stepView;
      if (!view || this._isBusy(step) || !this._isReady(step)) return;
      const token = this._pendingToken(step);
      this._pendingNext = token;
      try {
        // Stay on the step when it fails: the view shows why
        if (!(await step.beforeNext.run(view))) return;
      } finally {
        if (this._pendingNext === token) {
          this._pendingNext = undefined;
        }
      }
    }

    // Check the drive is still there, then ask before erasing it
    if (step?.erasesDrive?.(this._wizardState.selections)) {
      // Next is busy with this already, whatever else sent the event
      if (this._verifyingDrive) return;
      if (!(await this._verifySelectedDrive())) {
        return;
      }
      this._showConfirmDialog = true;
      return;
    }

    const skipTo = step?.skipTo?.(wizardState.getState().selections);
    const skipIndex = skipTo
      ? this._wizardState.steps.findIndex(({ id }) => id === skipTo)
      : -1;

    if (wizardState.isLastStep) {
      // Flow complete - go back to welcome
      this._resetErrorState();
      wizardState.reset();
      this._currentView = "welcome";
    } else if (skipIndex >= 0) {
      wizardState.goToStep(skipIndex);
    } else {
      wizardState.nextStep();
    }
  }

  /**
   * Confirm the selected path still belongs to the same device; the OS can
   * hand it to another one. On failure, clear the selection and go back to
   * the drive step, which re-scans and explains why it was cleared.
   *
   * Resolves false without acting if the user navigated, cancelled or changed
   * the selection while the scan ran: the result no longer applies.
   */
  private async _verifySelectedDrive(): Promise<boolean> {
    const started = wizardState.getState();
    const selection = readDriveSelection(started.selections);
    let found = false;

    if (selection) {
      this._verifyingDrive = true;
      try {
        found = !!findDrive(
          await listBlockDevices(),
          selection,
          started.selections.deviceConfig
        );
      } catch {
        // The scan failed, so the device cannot be confirmed. Treat that the
        // same as a device that is gone.
      } finally {
        this._verifyingDrive = false;
      }
    }

    // Every navigation, cancel or selection change replaces these.
    const current = wizardState.getState();
    if (
      current.selections !== started.selections ||
      current.currentStepIndex !== started.currentStepIndex
    ) {
      return false;
    }

    if (!found) {
      // Have the user pick again, rather than let Next carry it back here
      clearDriveSelection();
      wizardState.setSelection("driveSelectionLost", true);
      this._goToStep("drive");
    }
    return found;
  }

  private _goToStep(id: string) {
    const index = this._wizardState.steps.findIndex((step) => step.id === id);
    if (index >= 0) {
      wizardState.goToStep(index);
    }
  }

  private _onKeepInstallingOnQuit() {
    this._showQuitDialog = false;
  }

  private _onQuitAnyway() {
    this._showQuitDialog = false;
    void quitAnyway();
  }

  private _onDialogCancel() {
    this._showConfirmDialog = false;
  }

  private async _onDialogConfirm() {
    if (!this._showConfirmDialog) return;
    const confirmed = this._wizardState;
    const dialog = this._confirmDialog;
    if (!dialog) return;
    const closed = new Promise<void>((resolve) => {
      const onHide = (event: Event) => {
        if (
          event.composedPath()[0] !==
          dialog.shadowRoot?.querySelector("wa-dialog")
        )
          return;
        dialog.removeEventListener("wa-after-hide", onHide);
        resolve();
      };
      dialog.addEventListener("wa-after-hide", onHide);
    });
    this._showConfirmDialog = false;
    // The rest of the document is inert until the modal finishes closing.
    await closed;
    if (
      !this.isConnected ||
      this._wizardState.selections !== confirmed.selections ||
      this._wizardState.currentFlow !== confirmed.currentFlow ||
      this._wizardState.currentStepIndex !== confirmed.currentStepIndex
    )
      return;
    // The dialog can sit open for any length of time and the next step starts
    // writing immediately, so check the device one last time.
    if (!(await this._verifySelectedDrive())) {
      return;
    }
    // Proceed to flash step
    wizardState.nextStep();
  }

  private _onKeepInstalling() {
    this._showStopDialog = false;
  }

  private _onLeaveInstallation() {
    // Leaving detaches the progress view, which stops its waiting; the VM
    // and Home Assistant carry on
    this._showLeaveDialog = false;
    this._resetErrorState();
    wizardState.reset();
    this._currentView = "welcome";
  }

  private _onKeepWaiting() {
    this._showLeaveDialog = false;
  }

  private _onStopInstallation() {
    this._showStopDialog = false;
    // The install may have ended while the dialog was open. It does nothing
    // once it moved past where it can stop.
    if (this._installRunning) this._stepView?.stop?.();
  }

  private _onInstallStoppable(event: CustomEvent<{ stoppable: boolean }>) {
    this._installStoppable = event.detail.stoppable;
    // The install moved past where it can stop: there is nothing to ask
    if (!this._installStoppable && this._installRunning) {
      this._showStopDialog = false;
    }
  }

  private _onInstallLeavable(event: CustomEvent<{ leavable: boolean }>) {
    this._installLeavable = event.detail.leavable;
    if (!this._installLeavable) this._showLeaveDialog = false;
  }

  private _onInstallComplete() {
    // The install ended, so there is nothing left to stop, leave or quit,
    // whether or not the view said so first
    this._showStopDialog = false;
    this._showLeaveDialog = false;
    this._showQuitDialog = false;
    // The password is on the drive now; the success step needs only the name
    const wifi = this._wizardState.selections.wifi;
    if (wifi)
      wizardState.setSelection("wifi", { ssid: wifi.ssid, password: "" });
    wizardState.nextStep();
  }

  private _onInstallError(
    event: CustomEvent<{ retryable?: boolean; reconnect?: boolean }>
  ) {
    // The install ended, so there is nothing left to stop, leave or quit,
    // whether or not the view said so first
    this._showStopDialog = false;
    this._showLeaveDialog = false;
    this._showQuitDialog = false;
    this._installRetryable = event.detail?.retryable === true;
    this._installReconnect = event.detail?.reconnect === true;
    this._installError = true;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "app-shell": AppShell;
  }
}
