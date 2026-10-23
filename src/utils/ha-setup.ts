/**
 * Waiting for Home Assistant to finish installing in a new VM.
 *
 * Until Core runs, Home Assistant OS serves a landing page, which passes on
 * what Supervisor reports: the Core download's progress, and problems that
 * hold it up. Only `manifest.json`, served by Core itself, ends the wait.
 */
import { checkHaUpdated, getHaSetupStatus } from "../api/commands.js";
import type { HaSetupProblem } from "../api/types.js";
import { localize } from "../localization/localize.js";
import { homeAssistantUrl } from "./external-url.js";
import type { InstallerError } from "./installer-error.js";
import { pollUntil, throwIfCancelled } from "./polling.js";

/**
 * How long a problem may hold up the install, without the Core download
 * moving, before the wait ends. Supervisor tries again every 30 seconds, so
 * a passing problem clears well within this.
 */
export const HA_SETUP_STALL_MS = 10 * 60 * 1000;

/** What to show while Supervisor installs Home Assistant Core */
export interface HaSetupProgress {
  /** The Core download's progress (0-100), or null while there is none */
  progress: number | null;
  /** The problem holding up the install, or null */
  problem: HaSetupProblem | null;
}

/** What Home Assistant OS runs on: a virtual machine, or a device of its own */
export type HaosHost = "vm" | "device";

/** What a problem Supervisor reports means for the install on `host` */
export function haSetupProblemMessage(
  problem: HaSetupProblem,
  host: HaosHost = "vm"
): string {
  switch (problem) {
    case "no_internet":
      return localize("utils.ha_setup.no_internet");
    case "free_space":
      return host === "vm"
        ? localize("utils.ha_setup.free_space")
        : localize("utils.ha_setup.free_space_device");
    case "docker_ratelimit":
      return localize("utils.ha_setup.docker_ratelimit");
    case "update_failed":
      return localize("utils.ha_setup.update_failed");
  }
}

/** A problem held up the install too long. Shaped like a backend error. */
export class HaSetupStalledError extends Error implements InstallerError {
  readonly code: string;
  readonly retryable = true;
  readonly details: Record<string, unknown> = {};

  constructor(
    readonly problem: HaSetupProblem,
    address: string,
    host: HaosHost = "vm"
  ) {
    super(
      localize("utils.ha_setup.stalled", {
        problem: haSetupProblemMessage(problem, host),
        address,
      })
    );
    this.name = "HaSetupStalledError";
    // A fixed category for diagnostics, one per problem
    this.code = `home_assistant_${problem}`;
  }
}

export interface HaSetupWaitOptions {
  /** Delay between polls, in milliseconds. */
  interval: number;
  /** Give up after this many milliseconds. */
  timeout: number;
  /** Aborting this signal ends the wait with a `CancelledError`. */
  signal: AbortSignal;
  /** Message for the `PollTimeoutError` thrown when the deadline passes. */
  timeoutMessage: string;
  /** Called with what to show, each time Supervisor reports. */
  onProgress: (progress: HaSetupProgress) => void;
  /** What Home Assistant OS runs on, a VM unless given */
  host?: HaosHost;
}

/**
 * Wait for Home Assistant at `ipAddress` to finish installing, which is when
 * it serves `manifest.json`.
 *
 * A problem Supervisor reports shows at once, while the wait goes on. One
 * that lasts `HA_SETUP_STALL_MS` without a download moving ends the wait
 * with a `HaSetupStalledError`, rather than an hour-long timeout. Only a
 * report without it clears it: unanswered requests keep its clock running.
 * Once Core is downloaded, Supervisor stops the landing page to start Core,
 * so from then on only `manifest.json` or the timeout ends the wait.
 */
export async function waitForHaSetup(
  ipAddress: string,
  {
    interval,
    timeout,
    signal,
    timeoutMessage,
    onProgress,
    host,
  }: HaSetupWaitOptions
): Promise<void> {
  // The last problem reported, and since when
  let problem: HaSetupProblem | null = null;
  let problemSince = 0;
  // A download moves when its measured progress changes, also when it starts
  // over. A report without a measurement is not a move. Supervisor's own
  // update counts too: it comes first, and Core's progress leaves it out.
  const lastProgress = new Map<string, number>();
  let movedAt = Date.now();
  let downloaded = false;
  // The wait can end while a request is out, cancelled or at its deadline
  let ended = false;

  try {
    await pollUntil(
      async () => {
        if (await checkHaUpdated(ipAddress)) return true;

        const status = await getHaSetupStatus(ipAddress).catch(() => null);
        // A late answer must not reach the view, which may be on a retry by now
        if (ended) return null;
        throwIfCancelled(signal);

        const now = Date.now();
        // No answer is no news: what shows stays, and its clocks run on
        if (status) {
          const progress = status.core_install_progress;
          for (const [download, measured] of [
            ["core", progress],
            ["supervisor", status.supervisor_update_progress],
          ] as const) {
            if (measured !== null && measured !== lastProgress.get(download)) {
              lastProgress.set(download, measured);
              movedAt = now;
            }
          }
          // A download that starts over is not done
          if (progress !== null) downloaded = progress >= 100;
          const reported = status.problems[0] ?? null;
          if (reported && !problem) problemSince = now;
          problem = reported;
          // Like the landing page, a download at 0% shows as waiting
          onProgress({
            progress: progress !== null && progress > 0 ? progress : null,
            problem,
          });
        }

        if (
          problem &&
          !downloaded &&
          now - Math.max(problemSince, movedAt) >= HA_SETUP_STALL_MS
        ) {
          throw new HaSetupStalledError(
            problem,
            homeAssistantUrl(ipAddress),
            host
          );
        }
        return null;
      },
      {
        interval,
        timeout,
        signal,
        timeoutMessage,
        stopOn: (error) => error instanceof HaSetupStalledError,
      }
    );
  } finally {
    ended = true;
  }
}
