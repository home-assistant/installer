import type { ReactiveController, ReactiveControllerHost } from "lit";
import { wizardState } from "../state/wizard-state.js";

/** What `LatestRequest.start` hands out for one request. */
export interface RequestToken {
  /** No newer request started, and the host wasn't left, since this one */
  readonly latest: boolean;
  /**
   * Its answer is still wanted: it is the latest, and the host is in the
   * page, in the flow the request was started in
   */
  readonly current: boolean;
}

/**
 * The latest of a host's requests, like a check that can be started again
 * before the previous one answers. Answers can arrive out of order, or after
 * the user left the step or started another flow, so each request gets a
 * token to ask whether its answer still applies. Leaving the page makes
 * every running request stale, and so does `cancel`.
 */
export class LatestRequest implements ReactiveController {
  private _latest = 0;
  private _connected = false;

  constructor(host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostConnected() {
    this._connected = true;
  }

  hostDisconnected() {
    this._connected = false;
    this.cancel();
  }

  /** Start a request, which takes over from any that is still running. */
  start(): RequestToken {
    const request = ++this._latest;
    const flowGeneration = wizardState.flowGeneration;
    const isLatest = () => request === this._latest;
    const isCurrent = () =>
      isLatest() &&
      this._connected &&
      flowGeneration === wizardState.flowGeneration;
    return {
      get latest() {
        return isLatest();
      },
      get current() {
        return isCurrent();
      },
    };
  }

  /** Make every running request stale, as when the user goes back. */
  cancel() {
    this._latest++;
  }
}
