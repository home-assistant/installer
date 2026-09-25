import { LitElement, html, css, svg } from "lit";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import {
  downloadUtmImage,
  createUtmVm,
  resizeUtmVmDisk,
  startUtmVm,
  getUtmVmStatus,
  checkHaReady,
  checkHaUpdated,
  formatBytes,
  type VmStatusInfo,
} from "../../api/commands.js";
import type { FlashProgress, UtmVmConfig } from "../../api/types.js";
import {
  DEFAULT_CPU_CORES,
  DEFAULT_DISK_SIZE_GB,
  DEFAULT_MEMORY_MB,
  DEFAULT_UTM_VM_NAME,
} from "../../state/vm-defaults.js";
import {
  PollTimeoutError,
  isCancelled,
  pollUntil,
  throwIfCancelled,
} from "../../utils/polling.js";
import "../../components/progress-bar.js";

type InstallStage =
  | "downloading"
  | "extracting"
  | "creating"
  | "starting"
  | "waiting"
  | "ready"
  | "updating"
  | "complete"
  | "error";

// Stages that have measurable progress (0-100%)
const MEASURABLE_STAGES: InstallStage[] = ["downloading"];

// Stages that use indeterminate progress (waiting for something, or unknown total size)
const INDETERMINATE_STAGES: InstallStage[] = [
  "extracting",
  "creating",
  "starting",
  "waiting",
  "ready",
  "updating",
];

/** Delay between polls while waiting for the VM and Home Assistant */
const POLL_INTERVAL_MS = 2000;

/** How long to wait for the VM to report an IP address */
const VM_IP_TIMEOUT_MS = 5 * 60 * 1000;

/** How long to wait for the Home Assistant webserver to answer */
const HA_READY_TIMEOUT_MS = 5 * 60 * 1000;

/** How long to wait for Home Assistant to finish updating itself */
const HA_UPDATED_TIMEOUT_MS = 60 * 60 * 1000;

/** VM statuses that mean the VM does not need to be started again */
const RUNNING_VM_STATUSES = ["started", "running"];

@customElement("utm-progress-view")
export class UtmProgressView extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      box-sizing: border-box;
    }

    .mascot-container {
      width: 120px;
      height: 120px;
      margin-bottom: 2rem;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: visible;
    }

    .mascot-container.with-bubble {
      margin-left: 40px;
    }

    .casita-mascot {
      width: 100%;
      height: 100%;
    }

    .casita-tear {
      animation: tear-fall 1.5s ease-in infinite;
    }

    .casita-tear.delay {
      animation-delay: 0.75s;
    }

    @keyframes tear-fall {
      0% {
        opacity: 0;
        transform: translateY(-4px);
      }
      20% {
        opacity: 1;
      }
      100% {
        opacity: 0;
        transform: translateY(12px);
      }
    }

    h2 {
      font-size: 1.25rem;
      font-weight: 500;
      color: var(--ha-text-color, #212121);
      margin: 0 0 0.25rem 0;
      text-align: center;
    }

    .progress-section {
      width: 100%;
      max-width: 400px;
      margin-bottom: 1rem;
    }

    .progress-details {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-top: 0.75rem;
      font-size: 0.875rem;
      color: var(--ha-secondary-text-color, #727272);
    }

    .percentage {
      font-weight: 500;
      color: var(--ha-text-color, #212121);
    }

    .progress-right {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 0.125rem;
    }

    .eta {
      font-size: 0.75rem;
      color: var(--ha-secondary-text-color, #727272);
      min-height: 1.125rem;
    }

    .bytes-info {
      min-height: 1.25rem;
    }

    .progress-left {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.125rem;
    }

    .speed {
      font-size: 0.75rem;
      color: var(--ha-secondary-text-color, #727272);
      min-height: 1.125rem;
    }

    .error-section {
      text-align: center;
      margin-top: 1.5rem;
    }

    .error-message {
      color: var(--ha-error-color, #db4437);
      font-size: 0.9375rem;
      margin: 0 0 1.5rem 0;
      max-width: 400px;
    }

    .retry-button {
      padding: 0.75rem 1.5rem;
      font-size: 1rem;
      font-weight: 500;
      color: white;
      background-color: var(--ha-primary-color, #03a9f4);
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: background-color 0.2s ease;
    }

    .retry-button:hover {
      background-color: var(--ha-primary-color-dark, #0288d1);
    }

    .stages-indicator {
      display: flex;
      justify-content: center;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
    }

    .stage-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: var(--ha-border-color, #e0e0e0);
      transition: background-color 0.3s ease;
    }

    @media (prefers-color-scheme: dark) {
      .stage-dot {
        background-color: var(--ha-border-color, #444444);
      }
    }

    .stage-dot.active {
      animation: pulse-dot 1s ease-in-out infinite;
    }

    @keyframes pulse-dot {
      0%,
      100% {
        background-color: var(--ha-primary-color, #03a9f4);
      }
      50% {
        background-color: var(--ha-border-color, #e0e0e0);
      }
    }

    .stage-dot.complete {
      background-color: var(--ha-primary-color, #03a9f4);
    }

    .stage-dot.error {
      background-color: var(--ha-error-color, #db4437);
    }

    .thinking-cloud {
      position: absolute;
      top: -110px;
      right: -175px;
      width: 200px;
      height: 120px;
      z-index: 1;
    }

    .thinking-cloud .cloud-text {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: white;
      font-size: 1.25rem;
      font-weight: 500;
      white-space: nowrap;
      z-index: 2;
    }

    .thinking-cloud .cloud-bump {
      position: absolute;
      background-color: #18bcf2;
      border-radius: 50%;
    }

    .thinking-cloud .bump-1 {
      width: 70px;
      height: 70px;
      top: 30px;
      left: 0;
    }

    .thinking-cloud .bump-2 {
      width: 80px;
      height: 80px;
      top: 0;
      left: 25px;
    }

    .thinking-cloud .bump-3 {
      width: 90px;
      height: 85px;
      top: -5px;
      left: 70px;
    }

    .thinking-cloud .bump-4 {
      width: 75px;
      height: 75px;
      top: 5px;
      right: 10px;
    }

    .thinking-cloud .bump-5 {
      width: 65px;
      height: 65px;
      top: 40px;
      right: 0;
    }

    .thinking-cloud .bump-6 {
      width: 70px;
      height: 70px;
      bottom: 0;
      right: 20px;
    }

    .thinking-cloud .bump-7 {
      width: 80px;
      height: 75px;
      bottom: -5px;
      left: 60px;
    }

    .thinking-cloud .bump-8 {
      width: 65px;
      height: 65px;
      bottom: 5px;
      left: 10px;
    }

    .thinking-cloud .bump-center {
      width: 140px;
      height: 80px;
      border-radius: 50%;
      top: 20px;
      left: 30px;
    }

    .stage-description {
      font-size: 0.9375rem;
      font-weight: 400;
      color: var(--ha-secondary-text-color, #727272);
      margin: 0 0 1.5rem 0;
      text-align: center;
    }
  `;

  @state()
  private _wizardState: WizardState = wizardState.getState();

  @state()
  private _stage: InstallStage = "downloading";

  @state()
  private _progress = 0;

  @state()
  private _bytesProcessed = 0;

  @state()
  private _totalBytes = 0;

  @state()
  private _error: string | null = null;

  @state()
  private _isInstalling = false;

  private _stageStartTime: number | null = null;
  private _stageStartBytes: number = 0;
  private _unsubscribe?: () => void;
  private _abortController?: AbortController;

  /** Whether the install operation has failed */
  get hasError(): boolean {
    return this._error !== null;
  }

  /** Check if a stage uses indeterminate progress */
  private _isIndeterminate(stage: InstallStage): boolean {
    return INDETERMINATE_STAGES.includes(stage);
  }

  /** Check if a stage has measurable progress (0-100%) */
  private _hasMeasurableProgress(stage: InstallStage): boolean {
    return MEASURABLE_STAGES.includes(stage);
  }

  /**
   * Retry the install operation.
   *
   * Steps that already succeeded are picked up from the wizard state instead
   * of being run again - see `_startInstall`.
   */
  retry(): void {
    this._error = null;
    this._stage = "downloading";
    this._progress = 0;
    this._stageStartTime = null;
    this._stageStartBytes = 0;
    this._startInstall();
  }

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = wizardState.subscribe((state) => {
      this._wizardState = state;
    });

    this._startInstall();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    // Stop the install pipeline. Without this its polling loops keep running
    // after a cancel or a navigation and write wizard state and dispatch
    // events from a component that is no longer in the document.
    this._cancelInstall();
  }

  private _cancelInstall() {
    this._abortController?.abort();
    this._abortController = undefined;
    this._isInstalling = false;
  }

  private async _startInstall() {
    if (this._isInstalling) return;

    const controller = new AbortController();
    this._abortController = controller;
    const { signal } = controller;

    this._isInstalling = true;
    this._error = null;

    const selections = this._wizardState.selections;
    const vmName = selections.vmName || DEFAULT_UTM_VM_NAME;
    const cpuCores = selections.cpuCores ?? DEFAULT_CPU_CORES;
    const memoryMb = selections.memoryMb ?? DEFAULT_MEMORY_MB;
    const diskSizeGb = selections.diskSizeGb ?? DEFAULT_DISK_SIZE_GB;

    try {
      // Every step below is skipped when an earlier attempt already completed
      // it. Running the whole pipeline again after a late failure would create
      // a second VM with the same name and orphan the first one.
      let imagePath = selections.utmImagePath;
      if (!imagePath) {
        imagePath = await this._downloadImage(signal);
        throwIfCancelled(signal);
        wizardState.setSelection("utmImagePath", imagePath);
      }

      let vmId = selections.vmId;
      if (!vmId) {
        this._startStage("creating");

        const config: UtmVmConfig = {
          name: vmName,
          image_path: imagePath,
          cpu_cores: cpuCores,
          memory_mb: memoryMb,
          disk_size_gb: diskSizeGb,
          auto_start: false,
        };

        vmId = await createUtmVm(config);
        throwIfCancelled(signal);
        wizardState.setSelection("vmId", vmId);

        // Only applies to the disk image this VM was just created with
        await resizeUtmVmDisk(vmId, diskSizeGb);
        throwIfCancelled(signal);
      }

      this._startStage("starting");
      await this._ensureVmStarted(vmId, signal);
      throwIfCancelled(signal);

      // Wait for the VM to get an IP address
      this._startStage("waiting");
      const ipAddress =
        selections.ipAddress ?? (await this._waitForVmIp(vmId, signal));
      throwIfCancelled(signal);

      if (ipAddress) {
        wizardState.setSelection("ipAddress", ipAddress);

        // Wait for the Home Assistant webserver to be ready
        this._startStage("ready");
        await this._waitForHaReady(ipAddress, signal);
        throwIfCancelled(signal);

        // Wait for Home Assistant to finish updating
        this._startStage("updating");
        await this._waitForHaUpdated(ipAddress, signal);
        throwIfCancelled(signal);
      }

      // Complete
      this._stage = "complete";
      this._progress = 100;

      // Dispatch event to advance wizard
      this.dispatchEvent(
        new CustomEvent("install-complete", {
          bubbles: true,
          composed: true,
          detail: { ipAddress },
        })
      );
    } catch (error) {
      if (isCancelled(error) || signal.aborted) {
        // The view was detached mid-install - leave the wizard alone
        return;
      }

      this._stage = "error";
      this._error =
        error instanceof Error
          ? error.message
          : "Failed to create virtual machine";
      this.dispatchEvent(
        new CustomEvent("install-error", {
          bubbles: true,
          composed: true,
        })
      );
    } finally {
      // A newer attempt may own the component by now (cancel, then retry)
      if (this._abortController === controller) {
        this._isInstalling = false;
        this._abortController = undefined;
      }
    }
  }

  /** Move to an indeterminate stage, clearing the previous stage's progress */
  private _startStage(stage: InstallStage) {
    this._stage = stage;
    this._progress = 0;
    this._stageStartTime = null;
    this._bytesProcessed = 0;
    this._totalBytes = 0;
  }

  /** Download the HAOS qcow2 image, reporting download and extract progress */
  private async _downloadImage(signal: AbortSignal): Promise<string> {
    this._stage = "downloading";
    this._progress = 0;
    this._stageStartTime = Date.now();
    this._stageStartBytes = 0;

    return downloadUtmImage((progress: FlashProgress) => {
      // The download itself cannot be cancelled, but a detached view must
      // stop reporting on it
      if (signal.aborted) return;

      // Track stage changes
      if (progress.stage === "extracting" && this._stage === "downloading") {
        this._stage = "extracting";
        this._stageStartTime = Date.now();
        this._stageStartBytes = progress.bytes_processed;
      }

      // Use raw per-stage progress (0-100%)
      this._progress = Math.round(progress.progress);
      this._bytesProcessed = progress.bytes_processed;
      this._totalBytes = progress.total_bytes;
    });
  }

  /**
   * Start the VM unless it is already running.
   *
   * `createUtmVm` starts the VM it creates, and a resumed attempt can find it
   * still running, so starting unconditionally would fail for no reason.
   */
  private async _ensureVmStarted(
    vmId: string,
    signal: AbortSignal
  ): Promise<void> {
    let status: VmStatusInfo | null = null;
    try {
      status = await getUtmVmStatus(vmId);
    } catch {
      // Status is not available (yet) - fall through and start the VM
    }

    throwIfCancelled(signal);

    if (status && RUNNING_VM_STATUSES.includes(status.status)) {
      return;
    }

    await startUtmVm(vmId);
  }

  render() {
    if (this._error) {
      return this._renderError();
    }

    return this._renderProgress();
  }

  private _renderProgress() {
    const stage = this._stage;
    const percentage = this._progress;
    const isIndeterminate = this._isIndeterminate(stage);
    const hasMeasurable = this._hasMeasurableProgress(stage);

    const title = this._getStageTitle(stage);
    const description = this._getStageDescription(stage);

    // Add with-bubble class when showing thinking bubble (not complete or error)
    const hasBubble = stage !== "complete" && stage !== "error";

    return html`
      <div class="mascot-container ${hasBubble ? "with-bubble" : ""}">
        ${this._renderCasitaMascot(stage, title)}
      </div>

      <h2>${description}</h2>
      <p class="stage-description">
        Please keep this window open during installation
      </p>

      ${this._renderStagesIndicator(stage)}

      <div class="progress-section">
        <progress-bar
          .progress=${percentage}
          ?indeterminate=${isIndeterminate}
        ></progress-bar>
        ${hasMeasurable
          ? html`
              <div class="progress-details">
                <div class="progress-left">
                  <span class="bytes-info"
                    >${this._totalBytes > 0
                      ? `${formatBytes(this._bytesProcessed)} / ${formatBytes(this._totalBytes)}`
                      : ""}</span
                  >
                  <span class="speed"
                    >${this._totalBytes > 0 ? this._calculateSpeed() : ""}</span
                  >
                </div>
                <div class="progress-right">
                  <span class="percentage">${percentage}%</span>
                  <span class="eta"
                    >${this._totalBytes > 0
                      ? this._calculateEta() || "Calculating..."
                      : ""}</span
                  >
                </div>
              </div>
            `
          : ""}
      </div>
    `;
  }

  private _renderError() {
    return html`
      <div class="mascot-container">${this._renderCasitaSad()}</div>

      <h2>Installation failed</h2>

      <p class="error-message">${this._error}</p>
    `;
  }

  private _renderStagesIndicator(currentStage: string) {
    const stages = [
      { id: "downloading", label: "Downloading Home Assistant OS" },
      { id: "extracting", label: "Extracting the image" },
      { id: "creating", label: "Creating virtual machine" },
      { id: "starting", label: "Starting Home Assistant OS" },
      { id: "waiting", label: "Waiting for network connection" },
      { id: "ready", label: "Waiting for Home Assistant" },
      { id: "updating", label: "Installing latest Home Assistant" },
    ];
    const currentIndex = stages.findIndex((s) => s.id === currentStage);
    const isComplete = currentStage === "complete";
    const isError = currentStage === "error";

    return html`
      <div class="stages-indicator">
        ${stages.map((stage, index) => {
          let stateClass = "";
          if (isError) {
            stateClass = index <= currentIndex ? "error" : "";
          } else if (isComplete || index < currentIndex) {
            stateClass = "complete";
          } else if (index === currentIndex) {
            stateClass = "active";
          }
          return html`<div
            class="stage-dot ${stateClass}"
            title=${stage.label}
          ></div>`;
        })}
      </div>
    `;
  }

  private _calculateEta(): string | null {
    if (!this._stageStartTime) return null;

    // No ETA for stages without byte tracking
    if (this._totalBytes === 0) return null;

    const elapsed = (Date.now() - this._stageStartTime) / 1000;
    const bytesInStage = this._bytesProcessed - this._stageStartBytes;

    if (elapsed < 1 || bytesInStage <= 0) return null;

    const bytesPerSecond = bytesInStage / elapsed;
    if (bytesPerSecond <= 0) return null;

    const remainingBytes = this._totalBytes - this._bytesProcessed;
    const remainingSeconds = remainingBytes / bytesPerSecond;

    if (remainingSeconds < 0 || !isFinite(remainingSeconds)) return null;

    if (remainingSeconds < 60) {
      return "Less than a minute remaining";
    } else if (remainingSeconds < 3600) {
      const minutes = Math.ceil(remainingSeconds / 60);
      return `About ${minutes} minute${minutes !== 1 ? "s" : ""} remaining`;
    } else {
      const hours = Math.floor(remainingSeconds / 3600);
      const minutes = Math.ceil((remainingSeconds % 3600) / 60);
      return `About ${hours}h ${minutes}m remaining`;
    }
  }

  private _calculateSpeed(): string {
    if (!this._stageStartTime) return "";

    // No speed for stages without byte tracking
    if (this._totalBytes === 0) return "";

    const elapsed = (Date.now() - this._stageStartTime) / 1000;
    const bytesInStage = this._bytesProcessed - this._stageStartBytes;

    if (elapsed < 0.5 || bytesInStage <= 0) return "";

    const bytesPerSecond = bytesInStage / elapsed;
    if (bytesPerSecond <= 0 || !isFinite(bytesPerSecond)) return "";

    return `${formatBytes(bytesPerSecond)}/s`;
  }

  private _getStageTitle(stage: string): string {
    switch (stage) {
      case "downloading":
        return "Downloading";
      case "extracting":
        return "Extracting";
      case "creating":
        return "Creating";
      case "starting":
        return "Starting";
      case "waiting":
        return "Waiting";
      case "ready":
        return "Waiting";
      case "updating":
        return "Updating";
      case "complete":
        return "Complete!";
      case "error":
        return "Error";
      default:
        return "Installing";
    }
  }

  private _getStageDescription(stage: string): string {
    switch (stage) {
      case "downloading":
        return "Downloading Home Assistant OS";
      case "extracting":
        return "Extracting the image";
      case "creating":
        return "Creating virtual machine";
      case "starting":
        return "Starting Home Assistant OS";
      case "waiting":
        return "Waiting for network connection";
      case "ready":
        return "Waiting for Home Assistant";
      case "updating":
        return "Installing latest Home Assistant (this can take up to 20 minutes)";
      case "complete":
        return "Installation complete!";
      default:
        return "Installing Home Assistant";
    }
  }

  /**
   * Wait for the VM to get an IP address, polling every 2 seconds for up to
   * 5 minutes.
   *
   * A timeout here is not fatal: the VM is up either way and the success view
   * falls back to homeassistant.local. Without an address there is nothing to
   * poll Home Assistant on, so the caller skips the checks below.
   */
  private async _waitForVmIp(
    vmId: string,
    signal: AbortSignal
  ): Promise<string | null> {
    try {
      return await pollUntil(
        async () => (await getUtmVmStatus(vmId)).ip_address,
        {
          interval: POLL_INTERVAL_MS,
          timeout: VM_IP_TIMEOUT_MS,
          signal,
          timeoutMessage: "The virtual machine did not report an IP address",
        }
      );
    } catch (error) {
      if (error instanceof PollTimeoutError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Wait for the Home Assistant webserver to be ready on port 8123, polling
   * every 2 seconds for up to 5 minutes.
   *
   * A timeout throws: reporting "Installation complete!" for a VM where Home
   * Assistant never came up leaves the user with no idea what went wrong.
   */
  private async _waitForHaReady(
    ipAddress: string,
    signal: AbortSignal
  ): Promise<void> {
    await pollUntil(async () => (await checkHaReady(ipAddress)) || null, {
      interval: POLL_INTERVAL_MS,
      timeout: HA_READY_TIMEOUT_MS,
      signal,
      timeoutMessage:
        `Home Assistant did not respond at ${ipAddress}:8123 within 5 minutes. ` +
        `The virtual machine was created - check whether it is running in UTM, ` +
        `then try again to keep waiting for it.`,
    });
  }

  /**
   * Wait for Home Assistant to finish updating to the latest version.
   * This checks for the manifest.json endpoint which becomes available
   * after the initial setup and updates are complete.
   * Polls every 2 seconds for up to 1 hour.
   *
   * As with the readiness check, a timeout throws instead of quietly
   * reporting success.
   */
  private async _waitForHaUpdated(
    ipAddress: string,
    signal: AbortSignal
  ): Promise<void> {
    await pollUntil(async () => (await checkHaUpdated(ipAddress)) || null, {
      interval: POLL_INTERVAL_MS,
      timeout: HA_UPDATED_TIMEOUT_MS,
      signal,
      timeoutMessage:
        `Home Assistant did not finish installing updates within 60 minutes. ` +
        `Open http://${ipAddress}:8123 to check on it, or try again to keep ` +
        `waiting for it.`,
    });
  }

  private _renderCasitaMascot(stage: string, thinkingText: string) {
    switch (stage) {
      case "complete":
        return this._renderCasitaHappy();
      case "error":
        return this._renderCasitaSad();
      default:
        return this._renderCasitaThinking(thinkingText);
    }
  }

  private _renderCasitaThinking(text: string) {
    return html`
      <div style="position: relative; width: 100%; height: 100%;">
        ${svg`
          <svg class="casita-mascot" viewBox="0 -20 160 136.88" xmlns="http://www.w3.org/2000/svg">
            <!-- House body -->
            <path fill="#18bcf2" d="M120,109.38c0,4.12-3.38,7.5-7.5,7.5H7.5c-4.12,0-7.5-3.38-7.5-7.5v-45c0-4.12,2.39-9.89,5.3-12.8L54.7,2.19c2.92-2.92,7.69-2.92,10.61,0l49.39,49.39c2.92,2.92,5.3,8.68,5.3,12.8v45Z"/>
            <!-- Mouth with tongue (animated to the left and back) -->
            <path fill="#f2f4f9" d="M80,88.88c0-6.63-5.37-12-12-12s-12,5.37-12,12h24Z">
              <animateTransform attributeName="transform" type="translate" values="0,0;-6,0;0,0" dur="0.8s" begin="3.5s;tongueLick.end+4s" id="tongueLick"/>
            </path>
            <!-- Eyes (with blink animation) -->
            <ellipse fill="#f2f4f9" cx="33" cy="65.88" rx="8" ry="8">
              <animate attributeName="ry" values="8;1;8" dur="0.15s" begin="2.5s;blink1.end+3s" id="blink1"/>
            </ellipse>
            <ellipse fill="#f2f4f9" cx="87" cy="65.88" rx="8" ry="8">
              <animate attributeName="ry" values="8;1;8" dur="0.15s" begin="2.55s;blink2.end+3s" id="blink2"/>
            </ellipse>
            <!-- Nose/line -->
            <line fill="none" stroke="#f2f4f9" stroke-miterlimit="10" stroke-width="6" x1="40" y1="91.88" x2="80" y2="91.88"/>
            <!-- Thinking dots -->
            <circle fill="#18bcf2" cx="100" cy="25" r="5"/>
            <circle fill="#18bcf2" cx="120" cy="5" r="7"/>
            <circle fill="#18bcf2" cx="142" cy="-12" r="9"/>
          </svg>
        `}
        <div class="thinking-cloud">
          <div class="cloud-bump bump-center"></div>
          <div class="cloud-bump bump-1"></div>
          <div class="cloud-bump bump-2"></div>
          <div class="cloud-bump bump-3"></div>
          <div class="cloud-bump bump-4"></div>
          <div class="cloud-bump bump-5"></div>
          <div class="cloud-bump bump-6"></div>
          <div class="cloud-bump bump-7"></div>
          <div class="cloud-bump bump-8"></div>
          <div class="cloud-text">${text}...</div>
        </div>
      </div>
    `;
  }

  private _renderCasitaHappy() {
    return svg`
      <svg class="casita-mascot" viewBox="0 0 120 116.88" xmlns="http://www.w3.org/2000/svg">
        <path fill="#18bcf2" d="M120,109.38c0,4.12-3.38,7.5-7.5,7.5H7.5c-4.12,0-7.5-3.38-7.5-7.5v-45c0-4.12,2.39-9.89,5.3-12.8L54.7,2.19c2.92-2.92,7.69-2.92,10.61,0l49.39,49.39c2.92,2.92,5.3,8.68,5.3,12.8v45Z"/>
        <path fill="#f2f4f9" d="M80,80.88c0,11.05-8.95,20-20,20s-20-8.95-20-20h40Z"/>
        <circle fill="#f2f4f9" cx="33" cy="65.88" r="8"/>
        <circle fill="#f2f4f9" cx="87" cy="65.88" r="8"/>
      </svg>
    `;
  }

  private _renderCasitaSad() {
    return svg`
      <svg class="casita-mascot" viewBox="0 0 120 116.88" xmlns="http://www.w3.org/2000/svg">
        <path fill="#f7931e" d="M120,109.38c0,4.12-3.38,7.5-7.5,7.5H7.5c-4.12,0-7.5-3.38-7.5-7.5v-45c0-4.12,2.39-9.89,5.3-12.8L54.7,2.19c2.92-2.92,7.69-2.92,10.61,0l49.39,49.39c2.92,2.92,5.3,8.68,5.3,12.8v45Z"/>
        <!-- Big pleading eyes with blink -->
        <ellipse fill="#f2f4f9" cx="33" cy="65.88" rx="12" ry="12">
          <animate attributeName="ry" values="12;2;12" dur="0.15s" begin="2s;sadBlink1.end+3s" id="sadBlink1"/>
        </ellipse>
        <ellipse fill="#f2f4f9" cx="87" cy="65.88" rx="12" ry="12">
          <animate attributeName="ry" values="12;2;12" dur="0.15s" begin="2.05s;sadBlink2.end+3s" id="sadBlink2"/>
        </ellipse>
        <!-- Sad mouth -->
        <path fill="none" stroke="#f2f4f9" stroke-miterlimit="10" stroke-width="6" d="M44,96.88c0-8.84,7.16-16,16-16s16,7.16,16,16"/>
        <!-- Animated tears -->
        <path class="casita-tear" fill="#f2f4f9" d="M96.24,86.64c2.34,2.34,2.34,6.14,0,8.49s-6.14,2.34-8.49,0-2.34-6.14,0-8.49l4.24-4.24,4.24,4.24Z"/>
        <path class="casita-tear delay" fill="#f2f4f9" d="M32.24,86.64c2.34,2.34,2.34,6.14,0,8.49s-6.14,2.34-8.49,0-2.34-6.14,0-8.49l4.24-4.24,4.24,4.24Z"/>
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "utm-progress-view": UtmProgressView;
  }
}
