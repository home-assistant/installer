/**
 * Finding the device that starts from a written drive. Home Assistant OS
 * shows a landing page while it installs Home Assistant, and announces it on
 * the network under a new id each time it starts. One that wasn't there
 * when the drive was done is the device.
 */
import { findHomeAssistants } from "../api/commands.js";
import { throwIfCancelled } from "./polling.js";

/**
 * How long to look for the device. It is set up and started first, and
 * Home Assistant OS takes a few minutes to start the first time.
 */
export const DEVICE_ADDRESS_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Lookups that only note what is there already. The second notes a Home
 * Assistant whose answer the first missed. The device can't have started by
 * then: it is still waiting for the drive.
 */
const SURVEY_LOOKUPS = 2;

/** The ids of the Home Assistants on the network now */
async function survey(signal: AbortSignal): Promise<Set<string>> {
  const known = new Set<string>();
  for (let lookup = 0; lookup < SURVEY_LOOKUPS; lookup++) {
    // No lookup after the wait ended
    throwIfCancelled(signal);
    for (const { id } of await findHomeAssistants()) known.add(id);
  }
  return known;
}

/**
 * Look for the device: the first call notes the Home Assistants already
 * there, and each one after gives the address of a landing page that
 * wasn't, or null while there is none. Home Assistants themselves never
 * count, as one that was off while the first call looked isn't new.
 *
 * Once found, the device is where a later call looks: a wait tried again
 * checks on it there, as Home Assistant may have replaced its landing page.
 */
export function newLandingPageFinder(): (
  signal: AbortSignal
) => Promise<string | null> {
  let known: Set<string> | undefined;
  let device: string | undefined;
  return async (signal) => {
    if (device) return device;
    // A survey that failed is done again, as a whole
    if (!known) {
      known = await survey(signal);
      return null;
    }
    const before = known;
    device = (await findHomeAssistants()).find(
      ({ id, landing_page }) => landing_page && !before.has(id)
    )?.address;
    return device ?? null;
  };
}
