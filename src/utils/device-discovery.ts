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
 * Assistant whose answer the first missed.
 */
const SURVEY_LOOKUPS = 2;

/**
 * How long noting what is there is sure to miss the device: it is still
 * waiting for the drive, and Home Assistant OS starts after it is put in.
 */
const SURVEY_TIME_MS = 60 * 1000;

/**
 * Look for the device: the first lookups note the Home Assistants already
 * there, and each one after gives the address of a landing page that
 * wasn't, or null while there is none. Home Assistants themselves never
 * count, as one that was off while the first lookups ran isn't new.
 *
 * Only lookups in the first minute note what is there: one that only
 * answers later could take the device for one that was there all along.
 * When none answered in time, any landing page is the device.
 *
 * Once found, the device is where a later call looks: a wait tried again
 * checks on it there, as Home Assistant may have replaced its landing page.
 */
export function newLandingPageFinder(): (
  signal: AbortSignal
) => Promise<string | null> {
  const started = Date.now();
  const known = new Set<string>();
  let surveyed = 0;
  let device: string | undefined;
  const surveying = () =>
    surveyed < SURVEY_LOOKUPS && Date.now() - started < SURVEY_TIME_MS;

  return async (signal) => {
    if (device) return device;
    if (surveying()) {
      // A lookup that fails is asked again, by the next call
      while (surveying()) {
        // No lookup after the wait ended
        throwIfCancelled(signal);
        for (const { id } of await findHomeAssistants()) known.add(id);
        surveyed++;
      }
      return null;
    }
    device = (await findHomeAssistants()).find(
      ({ id, landing_page }) => landing_page && !known.has(id)
    )?.address;
    return device ?? null;
  };
}
