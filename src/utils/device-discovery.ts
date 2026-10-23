/**
 * Finding the device that starts from a written drive. Home Assistant OS
 * shows a landing page while it installs Home Assistant, and announces it on
 * the network under a new id each time it starts. One that wasn't there
 * when the drive was done is the device.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { findHomeAssistants } from "../api/commands.js";
import { wizardState } from "../state/wizard-state.js";
import { pollUntil, throwIfCancelled } from "./polling.js";

/**
 * How long to look for the device. It is set up and started first, and
 * Home Assistant OS takes a few minutes to start the first time.
 */
export const DEVICE_ADDRESS_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Lookups that only note what is there already. The second notes a Home
 * Assistant whose answer the first missed.
 */
const SURVEY_LOOKUPS = 2;

/**
 * How long noting what is there is sure to miss the device: it is still
 * waiting for the drive, and Home Assistant OS starts after it is put in.
 */
const SURVEY_TIME_MS = 60 * 1000;

/** Delay between lookups that failed, while noting what is there */
const SURVEY_RETRY_MS = 2000;

/**
 * Looks for the device: first it notes the Home Assistants already there,
 * then it finds a landing page that wasn't. Home Assistants themselves never
 * count, as one that was off while it noted what was there isn't new.
 *
 * Only lookups in its first minute note what is there: one that only
 * answers later could take the device for one that was there all along.
 * When none answered in time, any landing page is the device.
 */
export class DeviceFinder {
  private readonly _started = Date.now();
  private readonly _known = new Set<string>();
  private _surveyed = 0;
  private _device?: string;

  /** Whether lookups still note what is there */
  private get _surveying(): boolean {
    return (
      this._surveyed < SURVEY_LOOKUPS &&
      Date.now() - this._started < SURVEY_TIME_MS
    );
  }

  /**
   * Note what is there, while lookups still may. A lookup that fails
   * rejects; the next call asks again.
   */
  async survey(signal: AbortSignal): Promise<void> {
    while (this._surveying) {
      // No lookup after the wait ended
      throwIfCancelled(signal);
      for (const { id } of await findHomeAssistants()) this._known.add(id);
      this._surveyed++;
    }
  }

  /**
   * The device's address, or null while there is none. A call while it
   * still notes what is there only does that. Once found, the device is
   * where it looks: a wait tried again checks on it there, as Home
   * Assistant may have replaced its landing page.
   */
  async find(signal: AbortSignal): Promise<string | null> {
    if (this._device) return this._device;
    if (this._surveying) {
      await this.survey(signal);
      return null;
    }
    this._device = (await findHomeAssistants()).find(
      ({ id, landing_page }) => landing_page && !this._known.has(id)
    )?.address;
    return this._device ?? null;
  }
}

/** The flow's finder, made the first time it is asked for */
export function flowDeviceFinder(): DeviceFinder {
  let finder = wizardState.getState().selections.deviceFinder;
  if (!finder) {
    finder = new DeviceFinder();
    wizardState.setSelection("deviceFinder", finder);
  }
  return finder;
}

/**
 * Notes what is on the network while its host, the step that says how to
 * start the device, is on screen. That step comes as soon as the drive is
 * done, before the device can have started.
 */
export class DeviceSurvey implements ReactiveController {
  private _controller?: AbortController;

  constructor(host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostConnected() {
    const finder = flowDeviceFinder();
    const controller = new AbortController();
    this._controller = controller;
    // Lookups that fail are asked again, until it is too late to note
    // anything. Nothing waits on this: the waiting step asks on its own.
    void pollUntil(
      async () => {
        await finder.survey(controller.signal);
        return true;
      },
      {
        interval: SURVEY_RETRY_MS,
        timeout: SURVEY_TIME_MS,
        signal: controller.signal,
        timeoutMessage: "",
      }
    ).catch(() => {});
  }

  hostDisconnected() {
    this._controller?.abort();
    this._controller = undefined;
  }
}
