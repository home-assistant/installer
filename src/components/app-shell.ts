import { localize } from "../localization/localize.js";
import { LitElement, html, css, nothing } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import "./fab-button.js";

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
import "../views/ha-hardware/success-view.js";
import "../views/minipc/setup-method-view.js";
import "../views/minipc/architecture-selection-view.js";
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

// Import components
import type { WizardShell } from "./wizard-shell.js";
import "./wizard-shell.js";
import {
  wizardStep,
  type WizardStepDefinition,
  type WizardStepView,
} from "./wizard-steps.js";
import type { ConfirmDialog } from "./confirm-dialog.js";
import "./confirm-dialog.js";
import "./info-dialog.js";
import "./diagnostics-actions.js";

// Import state
import {
  wizardState,
  type WizardFlow,
  type WizardState,
} from "../state/wizard-state.js";
import { listBlockDevices, onCloseBlocked, quitAnyway } from "../api/index.js";
import { findDrive, readDriveSelection } from "../utils/drive-selection.js";
import { logFrontendError } from "../utils/diagnostics.js";
import { openExternalUrl } from "../utils/external-url.js";

export type ViewName =
  | "welcome"
  | "path-selection"
  | "other-options"
  | "connection-check"
  | "wizard";

// mdi:toolbox-outline
const mdiToolboxOutline =
  "M18 16H16V15H8V16H6V15H2V20H22V15H18V16M20 8H17V6C17 4.9 16.1 4 15 4H9C7.9 4 7 4.9 7 6V8H4C2.9 8 2 8.9 2 10V14H6V12H8V14H16V12H18V14H22V10C22 8.9 21.1 8 20 8M15 8H9V6H15V8Z";

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

    diagnostics-actions {
      position: absolute;
      bottom: 1rem;
      left: 1rem;
      z-index: 1;
    }
  `;

  @state()
  private _currentView: ViewName = "welcome";

  @state()
  private _wizardState: WizardState = wizardState.getState();

  @state()
  private _showConfirmDialog = false;

  @state()
  private _flashError = false;

  @state()
  private _vmInstallError = false;

  @state()
  private _installRetryable = false;

  // What the running `beforeNext` of a step started from: the flow, or the
  // selections. Leaving the flow (or changing a choice) replaces it, so a run
  // left behind holds up nothing.
  @state()
  private _pendingNext?: unknown;

  @state()
  private _verifyingDrive = false;

  @state()
  private _showStopDialog = false;

  /** Asks before leaving a VM install that can no longer stop */
  @state()
  private _showLeaveDialog = false;

  @state()
  private _stoppingFlash = false;

  /** Whether the running VM install can still stop without leaving anything */
  @state()
  private _vmStoppable = false;

  /** Whether the VM runs and only Home Assistant is awaited */
  @state()
  private _vmLeavable = false;

  @state()
  private _showQuitDialog = false;

  @query("wizard-shell")
  private _wizardShell?: WizardShell;

  @query("confirm-dialog")
  private _confirmDialog?: ConfirmDialog;

  private _unsubscribe?: () => void;
  private _stopCloseListener?: Promise<() => void>;
  private _pendingFlow?: WizardFlow;

  connectedCallback() {
    super.connectedCallback();
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
    this._unsubscribe?.();
    void this._stopCloseListener?.then((stop) => stop());
  }

  render() {
    const selections = this._wizardState.selections;

    return html`
      ${this._renderView()}
      ${this._currentView === "welcome" ? this._renderToolboxButton() : ""}
      ${this._currentView === "welcome"
        ? html`<diagnostics-actions about></diagnostics-actions>`
        : ""}
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
        .message=${wizardState.currentStep?.id === "flash"
          ? localize("components.app_shell.stop_installation_message")
          : localize("components.app_shell.stop_vm_installation_message")}
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
        .message=${localize("components.app_shell.leave_installation_message", {
          address: this._wizardState.selections.ipAddress
            ? `http://${this._wizardState.selections.ipAddress}`
            : "http://homeassistant.local",
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
    const currentStep = wizardState.currentStep;
    const flow = this._wizardState.currentFlow;
    const step = wizardStep(flow, currentStep?.id);
    const nextDisabled = !this._isReady(step);
    const nextLabel = this._getNextLabel(currentStep?.id);
    const busy = this._isBusy(step) ? step?.beforeNext?.label() : undefined;

    // A running flash keeps only Cancel, until it is stopping
    const flashRunning = currentStep?.id === "flash" && !this._flashError;

    // A running VM install keeps only Cancel, while it can still stop
    const vmRunning = this._isVmInstallRunning();

    // Determine when to hide footer (during active processes)
    // Once the VM runs, waiting for Home Assistant can take an hour, and
    // leaving no longer leaves anything half done
    const hideFooter =
      (flashRunning && this._stoppingFlash) ||
      (vmRunning && !this._vmStoppable && !this._vmLeavable);

    // Determine when to hide back button
    const hideBack =
      currentStep?.id === "flash" ||
      currentStep?.id === "success" ||
      (flow === "vm" && currentStep?.id === "install") ||
      (flow === "proxmox" && currentStep?.id === "install");

    // Done already returns to the start, so Cancel would only repeat it
    const hideCancel = currentStep?.id === "success";

    // Determine when to hide next button
    const hideNext =
      flashRunning ||
      vmRunning ||
      currentStep?.id === "method" ||
      (currentStep?.id === "install" &&
        (this._flashError || this._vmInstallError) &&
        !this._installRetryable);

    return html`
      <wizard-shell
        .nextDisabled=${nextDisabled || !!busy || this._verifyingDrive}
        .nextLabel=${busy
          ? busy
          : this._verifyingDrive
            ? localize("components.app_shell.checking_drive")
            : nextLabel}
        .hideFooter=${hideFooter}
        .hideBack=${hideBack}
        .hideNext=${hideNext}
        .hideCancel=${hideCancel}
        @wizard-cancel=${this._onWizardCancel}
        @wizard-exit=${this._onWizardExit}
        @wizard-next=${this._onWizardNext}
        @flash-complete=${this._onFlashComplete}
        @flash-error=${this._onFlashError}
        @flash-stop-failed=${this._onFlashStopFailed}
        @install-stoppable=${this._onInstallStoppable}
        @install-leavable=${this._onInstallLeavable}
        @install-complete=${this._onVmInstallComplete}
        @install-error=${this._onVmInstallError}
      >
        ${step?.render() ?? nothing}
      </wizard-shell>
    `;
  }

  private _getNextLabel(stepId: string | undefined): string {
    if (stepId === "flash" && this._flashError) {
      return this._installRetryable
        ? localize("common.try_again")
        : localize("components.app_shell.choose_another_drive");
    }
    if (stepId === "install" && this._vmInstallError) {
      return localize("common.try_again");
    }
    if (stepId === "confirm") {
      return localize("common.install");
    }
    if (stepId === "success") {
      return localize("common.done");
    }
    return localize("common.next");
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

  /** The view of the current step, the wizard shell's only child. */
  private get _stepView(): WizardStepView | null {
    return (this._wizardShell?.firstElementChild ??
      null) as WizardStepView | null;
  }

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
    // A running flash is stopped first, never just left behind
    if (wizardState.currentStep?.id === "flash" && !this._flashError) {
      this._showStopDialog = true;
      return;
    }
    if (this._isVmInstallRunning()) {
      if (this._vmStoppable) this._showStopDialog = true;
      else if (this._vmLeavable) this._showLeaveDialog = true;
      // Otherwise Cancel showed, but the install moved on to creating the VM
      return;
    }

    this._resetErrorState();
    wizardState.reset();
    this._currentView = "welcome";
  }

  /** Back on the first step returns to where the flow was picked. */
  private _onWizardExit() {
    this._resetErrorState();
    wizardState.reset();
    this._currentView = "path-selection";
  }

  /** A stale error flag would show Cancel/"Try again" over the next live write. */
  private _resetErrorState() {
    this._stoppingFlash = false;
    this._vmStoppable = false;
    this._vmLeavable = false;
    this._flashError = false;
    this._vmInstallError = false;
    this._installRetryable = false;
  }

  private async _onWizardNext() {
    const currentStep = wizardState.currentStep;
    const flow = this._wizardState.currentFlow;

    if (
      currentStep?.id === "install" &&
      (this._flashError || this._vmInstallError) &&
      !this._installRetryable
    )
      return;

    // Handle retry on flash error
    if (currentStep?.id === "flash" && this._flashError) {
      this._flashError = false;
      if (!this._installRetryable) {
        this._goToDriveStep();
        return;
      }
      this._stepView?.retry?.();
      return;
    }

    // Handle retry on a UTM or Proxmox install error
    if (currentStep?.id === "install" && this._vmInstallError) {
      this._vmInstallError = false;
      this._stepView?.retry?.();
      return;
    }

    const step = wizardStep(flow, currentStep?.id);
    if (step?.beforeNext) {
      // Next is only clickable while enabled, but the step must never proceed
      // while it isn't ready, whatever triggered the event
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

    // Show confirmation dialog before proceeding from confirm step (only for
    // the flows that write a drive)
    if (
      currentStep?.id === "confirm" &&
      (flow === "sbc" || flow === "minipc" || flow === "ha-hardware")
    ) {
      if (!(await this._verifySelectedDrive())) {
        return;
      }
      this._showConfirmDialog = true;
      return;
    }

    if (wizardState.isLastStep) {
      // Flow complete - go back to welcome
      this._resetErrorState();
      wizardState.reset();
      this._currentView = "welcome";
    } else {
      wizardState.nextStep();
    }
  }

  /**
   * Confirm the selected path still belongs to the same device; the OS can
   * hand it to another one. On failure, go back to the drive step, which
   * re-scans and explains why the selection was cleared.
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
      this._goToDriveStep();
    }
    return found;
  }

  private _goToDriveStep() {
    const index = this._wizardState.steps.findIndex(
      (step) => step.id === "drive"
    );
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

  private _onFlashComplete() {
    this._showStopDialog = false;
    this._stoppingFlash = false;
    // The password is on the drive now; the success step needs only the name
    const wifi = this._wizardState.selections.wifi;
    if (wifi)
      wizardState.setSelection("wifi", { ssid: wifi.ssid, password: "" });
    // Advance to success/done step after flash completes
    wizardState.nextStep();
  }

  private _onFlashError(event: CustomEvent<{ retryable?: boolean }>) {
    this._showStopDialog = false;
    this._stoppingFlash = false;
    this._installRetryable = event.detail?.retryable === true;
    this._flashError = true;
  }

  /** The stop request never reached the backend: the flash keeps going. */
  private _onFlashStopFailed() {
    this._stoppingFlash = false;
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
    if (this._isVmInstallRunning()) {
      this._stopVmInstall();
      return;
    }

    // The flash may have ended while the dialog was open
    if (wizardState.currentStep?.id !== "flash" || this._flashError) return;

    const progressView = this._stepView;
    if (!progressView?.stop) return;

    this._stoppingFlash = true;
    progressView.stop();
  }

  /** Whether a UTM or Proxmox install runs, and has not failed. */
  private _isVmInstallRunning(): boolean {
    if (wizardState.currentStep?.id !== "install") return false;

    const flow = this._wizardState.currentFlow;
    return (flow === "vm" || flow === "proxmox") && !this._vmInstallError;
  }

  private _stopVmInstall() {
    // Does nothing once the install moved past where it can stop
    this._stepView?.stop?.();
  }

  private _onInstallStoppable(event: CustomEvent<{ stoppable: boolean }>) {
    this._vmStoppable = event.detail.stoppable;
    // The install moved past where it can stop: there is nothing to ask
    if (!this._vmStoppable && this._isVmInstallRunning()) {
      this._showStopDialog = false;
    }
  }

  private _onInstallLeavable(event: CustomEvent<{ leavable: boolean }>) {
    this._vmLeavable = event.detail.leavable;
    if (!this._vmLeavable) this._showLeaveDialog = false;
  }

  private _onVmInstallComplete() {
    // Advance to success step after the UTM or Proxmox install completes
    wizardState.nextStep();
  }

  private _onVmInstallError(event: CustomEvent<{ retryable?: boolean }>) {
    this._installRetryable = event.detail?.retryable === true;
    this._vmInstallError = true;
  }

  private _renderToolboxButton() {
    return html`
      <fab-button
        .path=${mdiToolboxOutline}
        label=${localize("components.app_shell.open_home_toolbox")}
        @click=${this._onToolboxOpen}
      ></fab-button>
    `;
  }

  private async _onToolboxOpen() {
    await openExternalUrl("https://toolbox.openhomefoundation.org/");
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "app-shell": AppShell;
  }
}
