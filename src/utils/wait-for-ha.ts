/**
 * Waits for a freshly installed Home Assistant VM to come up, shared by the
 * VM install flows (UTM, Proxmox).
 *
 * Both waits throw on timeout instead of resolving: reporting "Installation
 * complete!" for a VM where Home Assistant never came up leaves the user with
 * no idea what went wrong.
 */

import { checkHaReady, checkHaUpdated } from "../api/commands.js";
import { pollUntil } from "./polling.js";

/** Delay between checks */
const POLL_INTERVAL_MS = 2000;

/** How long to wait for the Home Assistant webserver to answer */
const HA_READY_TIMEOUT_MS = 5 * 60 * 1000;

/** How long to wait for Home Assistant to finish updating itself */
const HA_UPDATED_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Wait for the Home Assistant webserver at `ipAddress` to answer on port 80.
 *
 * @param hypervisor Where the VM runs ("UTM", "Proxmox"), named in the timeout
 *   message so the user knows where to check on it
 */
export async function waitForHaReady(
  ipAddress: string,
  hypervisor: string,
  signal: AbortSignal
): Promise<void> {
  await pollUntil(async () => (await checkHaReady(ipAddress)) || null, {
    interval: POLL_INTERVAL_MS,
    timeout: HA_READY_TIMEOUT_MS,
    signal,
    timeoutMessage:
      `Home Assistant did not respond at ${ipAddress} within 5 minutes. ` +
      `The virtual machine was created - check whether it is running in ` +
      `${hypervisor}, then try again to keep waiting for it.`,
  });
}

/**
 * Wait for Home Assistant at `ipAddress` to finish updating to the latest
 * version, which is when it starts serving `manifest.json`.
 */
export async function waitForHaUpdated(
  ipAddress: string,
  signal: AbortSignal
): Promise<void> {
  await pollUntil(async () => (await checkHaUpdated(ipAddress)) || null, {
    interval: POLL_INTERVAL_MS,
    timeout: HA_UPDATED_TIMEOUT_MS,
    signal,
    timeoutMessage:
      `Home Assistant did not finish installing updates within 60 minutes. ` +
      `Open http://${ipAddress} to check on it, or try again to keep ` +
      `waiting for it.`,
  });
}
