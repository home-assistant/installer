import { localize } from "../localization/localize.js";
import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./fab-button.js";

// Import views
import "../views/welcome-view.js";
import "../views/connection-check-view.js";
import "../views/path-selection-view.js";
import "../views/other-options-view.js";
import "../views/sbc/device-selection-view.js";
import "../views/sbc/drive-selection-view.js";
import "../views/sbc/confirmation-view.js";
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
import "./wizard-shell.js";
import "./confirm-dialog.js";
import "./diagnostics-actions.js";

// Import state
import {
  wizardState,
  type WizardFlow,
  type WizardState,
} from "../state/wizard-state.js";
import { listBlockDevices } from "../api/index.js";
import { findDrive, readDriveSelection } from "../utils/drive-selection.js";
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
  private _utmInstallError = false;

  @state()
  private _proxmoxInstallError = false;

  @state()
  private _installRetryable = false;

  @state()
  private _proxmoxConnecting = false;

  @state()
  private _verifyingDrive = false;

  private _unsubscribe?: () => void;
  private _pendingFlow?: WizardFlow;

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = wizardState.subscribe((state) => {
      this._wizardState = state;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
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
    const nextDisabled = this._isNextDisabled(flow, currentStep?.id);
    const nextLabel = this._getNextLabel(currentStep?.id);

    // Determine when to hide footer (during active processes)
    const hideFooter =
      (currentStep?.id === "flash" && !this._flashError) ||
      (flow === "vm" &&
        currentStep?.id === "install" &&
        !this._utmInstallError) ||
      (flow === "proxmox" &&
        currentStep?.id === "install" &&
        !this._proxmoxInstallError);

    // Determine when to hide back button
    const hideBack =
      currentStep?.id === "flash" ||
      currentStep?.id === "success" ||
      (flow === "vm" && currentStep?.id === "install") ||
      (flow === "proxmox" && currentStep?.id === "install");

    // Determine when to hide next button
    const hideNext =
      currentStep?.id === "method" ||
      (currentStep?.id === "install" &&
        (this._flashError ||
          this._utmInstallError ||
          this._proxmoxInstallError) &&
        !this._installRetryable);

    return html`
      <wizard-shell
        .nextDisabled=${nextDisabled ||
        this._proxmoxConnecting ||
        this._verifyingDrive}
        .nextLabel=${this._proxmoxConnecting
          ? localize("components.app_shell.connecting")
          : this._verifyingDrive
            ? localize("components.app_shell.checking_drive")
            : nextLabel}
        .hideFooter=${hideFooter}
        .hideBack=${hideBack}
        .hideNext=${hideNext}
        @wizard-cancel=${this._onWizardCancel}
        @wizard-next=${this._onWizardNext}
        @flash-complete=${this._onFlashComplete}
        @flash-error=${this._onFlashError}
      >
        ${this._renderWizardStep(flow, currentStep?.id)}
      </wizard-shell>
    `;
  }

  private _getNextLabel(stepId: string | undefined): string {
    if (stepId === "flash" && this._flashError) {
      return this._installRetryable
        ? localize("components.app_shell.try_again")
        : localize("components.app_shell.choose_another_drive");
    }
    if (
      stepId === "install" &&
      (this._utmInstallError || this._proxmoxInstallError)
    ) {
      return localize("components.app_shell.try_again");
    }
    if (stepId === "confirm") {
      return localize("common.install");
    }
    if (stepId === "success") {
      return localize("common.done");
    }
    return localize("common.next");
  }

  private _isNextDisabled(
    flow: WizardFlow | null,
    stepId: string | undefined
  ): boolean {
    const selections = this._wizardState.selections;

    // Check if required selections are made for current step
    if (flow === "sbc" || flow === "ha-hardware") {
      if (stepId === "device") {
        return !selections.deviceCatalogReady || !selections.device;
      }
      if (stepId === "drive") {
        return !selections.drive;
      }
    }

    if (flow === "minipc") {
      if (stepId === "architecture") {
        return !selections.deviceCatalogReady || !selections.device;
      }
      if (stepId === "drive") {
        return !selections.drive;
      }
    }

    // VM (UTM) flow - require UTM to be installed on check step
    if (flow === "vm") {
      if (stepId === "check") {
        return !selections.utmInstalled;
      }
    }

    // Proxmox flow
    if (flow === "proxmox") {
      if (stepId === "configure") {
        return (
          !selections.proxmoxConfigureReady ||
          !selections.proxmoxNode ||
          !selections.proxmoxStorage ||
          !selections.proxmoxBridge ||
          !selections.proxmoxBridgeReady ||
          !selections.proxmoxImportReady
        );
      }
    }

    return false;
  }

  private _renderWizardStep(
    flow: WizardFlow | null,
    stepId: string | undefined
  ) {
    // SBC Flow steps
    if (flow === "sbc") {
      switch (stepId) {
        case "device":
          return html`<device-selection-view></device-selection-view>`;
        case "drive":
          return html`<drive-selection-view></drive-selection-view>`;
        case "confirm":
          return html`<confirmation-view></confirmation-view>`;
        case "flash":
          return html`<progress-view></progress-view>`;
        case "success":
          return html`<success-view></success-view>`;
      }
    }

    // Home Assistant hardware: the SBC steps, with its own device picker and
    // device-specific next steps
    if (flow === "ha-hardware") {
      switch (stepId) {
        case "device":
          return html`<ha-hardware-device-selection-view></ha-hardware-device-selection-view>`;
        case "drive":
          return html`<drive-selection-view></drive-selection-view>`;
        case "confirm":
          return html`<confirmation-view></confirmation-view>`;
        case "flash":
          return html`<progress-view></progress-view>`;
        case "success":
          return html`<ha-hardware-success-view></ha-hardware-success-view>`;
      }
    }

    // Mini PC Flow steps
    if (flow === "minipc") {
      switch (stepId) {
        case "method":
          return html`<minipc-setup-method-view></minipc-setup-method-view>`;
        case "architecture":
          return html`<minipc-architecture-selection-view></minipc-architecture-selection-view>`;
        case "drive":
          return html`<drive-selection-view></drive-selection-view>`;
        case "confirm":
          return html`<confirmation-view></confirmation-view>`;
        case "flash":
          return html`<progress-view></progress-view>`;
        case "success":
          return html`<success-view></success-view>`;
      }
    }

    // VM (UTM) Flow steps
    if (flow === "vm") {
      switch (stepId) {
        case "check":
          return html`<utm-check-view></utm-check-view>`;
        case "configure":
          return html`<utm-configure-view></utm-configure-view>`;
        case "confirm":
          return html`<utm-confirm-view></utm-confirm-view>`;
        case "install":
          return html`<utm-progress-view
            @install-complete=${this._onUtmInstallComplete}
            @install-error=${this._onUtmInstallError}
          ></utm-progress-view>`;
        case "success":
          return html`<utm-success-view></utm-success-view>`;
      }
    }

    // Proxmox Flow steps
    if (flow === "proxmox") {
      switch (stepId) {
        case "connection":
          return html`<proxmox-connect-view></proxmox-connect-view>`;
        case "configure":
          return html`<proxmox-configure-view></proxmox-configure-view>`;
        case "confirm":
          return html`<proxmox-confirm-view></proxmox-confirm-view>`;
        case "install":
          return html`<proxmox-progress-view
            @install-complete=${this._onProxmoxInstallComplete}
            @install-error=${this._onProxmoxInstallError}
          ></proxmox-progress-view>`;
        case "success":
          return html`<proxmox-success-view></proxmox-success-view>`;
      }
    }

    return nothing;
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
    this._resetErrorState();
    wizardState.reset();
    this._currentView = "welcome";
  }

  /** A stale error flag would show Cancel/"Try again" over the next live write. */
  private _resetErrorState() {
    this._flashError = false;
    this._utmInstallError = false;
    this._proxmoxInstallError = false;
    this._installRetryable = false;
  }

  private async _onWizardNext() {
    const currentStep = wizardState.currentStep;
    const flow = this._wizardState.currentFlow;

    if (
      currentStep?.id === "install" &&
      (this._flashError ||
        this._utmInstallError ||
        this._proxmoxInstallError) &&
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
      const wizardShell = this.shadowRoot?.querySelector("wizard-shell");
      const progressView = wizardShell?.querySelector("progress-view") as
        | (HTMLElement & { retry: () => void })
        | null;
      progressView?.retry();
      return;
    }

    // Handle retry on UTM install error
    if (
      flow === "vm" &&
      currentStep?.id === "install" &&
      this._utmInstallError
    ) {
      this._utmInstallError = false;
      const wizardShell = this.shadowRoot?.querySelector("wizard-shell");
      const utmProgressView = wizardShell?.querySelector(
        "utm-progress-view"
      ) as (HTMLElement & { retry: () => void }) | null;
      utmProgressView?.retry();
      return;
    }

    // Handle retry on Proxmox install error
    if (
      flow === "proxmox" &&
      currentStep?.id === "install" &&
      this._proxmoxInstallError
    ) {
      this._proxmoxInstallError = false;
      const wizardShell = this.shadowRoot?.querySelector("wizard-shell");
      const proxmoxProgressView = wizardShell?.querySelector(
        "proxmox-progress-view"
      ) as (HTMLElement & { retry: () => void }) | null;
      proxmoxProgressView?.retry();
      return;
    }

    // Handle Proxmox connection step - connect then proceed if successful
    if (flow === "proxmox" && currentStep?.id === "connection") {
      const wizardShell = this.shadowRoot?.querySelector("wizard-shell");
      const connectView = wizardShell?.querySelector("proxmox-connect-view") as
        | (HTMLElement & { connect: () => Promise<boolean> })
        | null;
      if (connectView) {
        this._proxmoxConnecting = true;
        try {
          const success = await connectView.connect();
          if (!success) {
            return; // Stay on current step, error shown in view
          }
        } finally {
          this._proxmoxConnecting = false;
        }
      }
    }

    // Next is only clickable while enabled, but the step must never proceed
    // without import storage, whatever triggered the event
    if (
      flow === "proxmox" &&
      currentStep?.id === "configure" &&
      this._isNextDisabled(flow, currentStep.id)
    ) {
      return;
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

  private _onDialogCancel() {
    this._showConfirmDialog = false;
  }

  private async _onDialogConfirm() {
    if (!this._showConfirmDialog) return;
    const confirmed = this._wizardState;
    const dialog = this.shadowRoot?.querySelector("confirm-dialog");
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
    // Advance to success/done step after flash completes
    wizardState.nextStep();
  }

  private _onFlashError(event: CustomEvent<{ retryable?: boolean }>) {
    this._installRetryable = event.detail?.retryable === true;
    this._flashError = true;
  }

  private _onUtmInstallComplete() {
    // Advance to success step after UTM install completes
    wizardState.nextStep();
  }

  private _onUtmInstallError(event: CustomEvent<{ retryable?: boolean }>) {
    this._installRetryable = event.detail?.retryable === true;
    this._utmInstallError = true;
  }

  private _onProxmoxInstallComplete() {
    // Advance to success step after Proxmox install completes
    wizardState.nextStep();
  }

  private _onProxmoxInstallError(event: CustomEvent<{ retryable?: boolean }>) {
    this._installRetryable = event.detail?.retryable === true;
    this._proxmoxInstallError = true;
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
