/**
 * What a VM install waits for once its VM runs: an address, then Home
 * Assistant answering there, then Home Assistant done updating. The UTM and
 * Proxmox flows share it, so a fix to these checks lands in both.
 */
import { checkHaReady, checkHaUpdated } from "../api/commands.js";
import { wizardState } from "../state/wizard-state.js";
import { PollTimeoutError, pollUntil, throwIfCancelled } from "./polling.js";

/** The waits, in order. The VM runs during all of them, so leaving is fine. */
export const WAIT_STAGES = ["waiting", "ready", "updating"] as const;

export type WaitStage = (typeof WAIT_STAGES)[number];

export function isWaitStage(stage: string): stage is WaitStage {
  return (WAIT_STAGES as readonly string[]).includes(stage);
}

const POLL_INTERVAL_MS = 2000;

/** How long to wait for the VM to report an IP address */
const VM_IP_TIMEOUT_MS = 5 * 60 * 1000;

/** How long to wait for the Home Assistant webserver to answer */
const HA_READY_TIMEOUT_MS = 5 * 60 * 1000;

/** How long to wait for Home Assistant to finish updating itself */
const HA_UPDATED_TIMEOUT_MS = 60 * 60 * 1000;

export interface HomeAssistantWait {
  /** Ask the VM for its address, `null` or `undefined` while it has none */
  vmAddress: () => Promise<string | null | undefined>;
  /** Errors from `vmAddress` that asking again cannot fix */
  stopOn: (error: unknown) => boolean;
  /** Called as each wait starts */
  onStage: (stage: WaitStage) => void;
  /** Each wait's timeout, in the flow's own words */
  messages: {
    noAddress: string;
    notResponding: (ipAddress: string) => string;
    notUpdated: (address: string) => string;
  };
  signal: AbortSignal;
}

/**
 * Wait for the VM's address, then for Home Assistant to answer there and to
 * finish updating, and return the address. A wait that runs out throws a
 * `PollTimeoutError` instead of reporting success.
 */
export async function waitForHomeAssistant({
  vmAddress,
  stopOn,
  onStage,
  messages,
  signal,
}: HomeAssistantWait): Promise<string> {
  // Asked again on a retry rather than reusing the last one: a restarted VM
  // can get a new DHCP lease
  onStage("waiting");
  wizardState.setSelection("ipAddress", undefined);
  const ipAddress = await pollUntil(vmAddress, {
    interval: POLL_INTERVAL_MS,
    timeout: VM_IP_TIMEOUT_MS,
    signal,
    timeoutMessage: messages.noAddress,
    stopOn,
  });
  throwIfCancelled(signal);
  wizardState.setSelection("ipAddress", ipAddress);

  onStage("ready");
  await pollUntil(async () => (await checkHaReady(ipAddress)) || null, {
    interval: POLL_INTERVAL_MS,
    timeout: HA_READY_TIMEOUT_MS,
    signal,
    timeoutMessage: messages.notResponding(ipAddress),
  });
  throwIfCancelled(signal);

  // Home Assistant serves `manifest.json` once it has finished updating
  onStage("updating");
  await pollUntil(async () => (await checkHaUpdated(ipAddress)) || null, {
    interval: POLL_INTERVAL_MS,
    timeout: HA_UPDATED_TIMEOUT_MS,
    signal,
    timeoutMessage: messages.notUpdated(`http://${ipAddress}`),
  });
  throwIfCancelled(signal);

  return ipAddress;
}

/** Where Home Assistant is being checked, once there is an address to check. */
export function checkedAddress(
  stage: string,
  ipAddress: string | undefined
): string | null {
  return ipAddress && (stage === "ready" || stage === "updating")
    ? `http://${ipAddress}`
    : null;
}

/** A wait that ran out is shown, and can be tried again, like any error. */
export function waitError(error: unknown): unknown {
  return error instanceof PollTimeoutError
    ? { code: "timeout", message: error.message, retryable: true, details: {} }
    : error;
}
