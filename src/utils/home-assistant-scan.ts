/**
 * Finding the Home Assistants already on the local network, for the welcome
 * screen to offer them. Each announces itself over mDNS, and Home Assistant
 * OS's landing page does so too while it installs Home Assistant. Home
 * Assistant itself says whether its owner has onboarded it yet.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { checkHaOnboarded, findHomeAssistants } from "../api/commands.js";
import type { HaAnnouncement } from "../api/types.js";
import { delay } from "./polling.js";

/** Delay between lookups. Each listens for a few seconds of its own. */
export const SCAN_INTERVAL_MS = 10_000;

/**
 * Lookups in a row that may miss a Home Assistant before it is no longer
 * shown. An answer can get lost, and one lookup that misses it shouldn't
 * have it come and go.
 */
const MISSES_TO_FORGET = 2;

/**
 * What a Home Assistant is ready for: Home Assistant OS still installs it,
 * its owner has yet to onboard it, it is onboarded, or it didn't tell.
 */
export type HomeAssistantState =
  | "installing"
  | "not_onboarded"
  | "onboarded"
  | "unknown";

export interface FoundHomeAssistant {
  /** Where it answers: an IPv4 address, with the port unless that is 80 */
  address: string;
  /** Where to open it in the browser, over HTTPS if it takes that */
  url: string;
  /** The name it announces, if any */
  name: string | null;
  state: HomeAssistantState;
}

interface Entry {
  announcement: HaAnnouncement;
  /** The last clear answer whether it is onboarded */
  onboarded: boolean | null;
  /** Lookups in a row that missed it */
  missed: number;
}

/**
 * Looks for Home Assistant on the network for as long as its host is on
 * screen, and has the host render again whenever what it found changes.
 *
 * Lookups that fail are asked again at the next one, keeping what was found.
 */
export class HomeAssistantScan implements ReactiveController {
  /** By address: a landing page that starts again announces a new id there */
  private readonly _entries = new Map<string, Entry>();
  private _controller?: AbortController;

  constructor(private readonly _host: ReactiveControllerHost) {
    _host.addController(this);
  }

  /** What was found, by name, then address, those without a name last */
  get found(): FoundHomeAssistant[] {
    return [...this._entries.values()]
      .map(({ announcement, onboarded }) => ({
        address: announcement.address,
        url: announcement.url,
        name: announcement.name,
        state: announcement.landing_page
          ? ("installing" as const)
          : onboarded === null
            ? ("unknown" as const)
            : onboarded
              ? ("onboarded" as const)
              : ("not_onboarded" as const),
      }))
      .sort(
        (a, b) =>
          Number(!a.name) - Number(!b.name) ||
          (a.name ?? "").localeCompare(b.name ?? "") ||
          a.address.localeCompare(b.address)
      );
  }

  hostConnected() {
    const controller = new AbortController();
    this._controller = controller;
    void this._scan(controller.signal);
  }

  hostDisconnected() {
    this._controller?.abort();
    this._controller = undefined;
  }

  private async _scan(signal: AbortSignal) {
    for (;;) {
      try {
        await this._lookup(signal);
      } catch {
        // Asked again at the next lookup
      }
      try {
        await delay(SCAN_INTERVAL_MS, signal);
      } catch {
        return;
      }
    }
  }

  private async _lookup(signal: AbortSignal) {
    const announcements = onePerAddress(await findHomeAssistants());
    // Nothing more is asked once the host is gone
    if (signal.aborted) return;
    // Only shown once it said whether it is onboarded, so what it is
    // ready for doesn't change right after it appears
    const onboarded = await Promise.all(
      announcements.map((announcement) =>
        announcement.landing_page
          ? null
          : checkHaOnboarded(announcement.address).catch(() => null)
      )
    );
    // The host may be gone, or on screen again with a lookup of its own
    if (signal.aborted) return;

    const seen = new Set(announcements.map(({ address }) => address));
    for (const [address, entry] of this._entries) {
      if (!seen.has(address) && ++entry.missed >= MISSES_TO_FORGET) {
        this._entries.delete(address);
      }
    }
    announcements.forEach((announcement, index) => {
      const known = this._entries.get(announcement.address);
      // An answer that doesn't tell keeps what the last one told about the
      // same Home Assistant: not one that has since replaced its landing
      // page, nor another that now answers at the address
      const kept =
        known &&
        known.announcement.id === announcement.id &&
        known.announcement.landing_page === announcement.landing_page
          ? known.onboarded
          : null;
      this._entries.set(announcement.address, {
        announcement,
        onboarded: onboarded[index] ?? kept,
        missed: 0,
      });
    });
    this._forgetReplacedLandingPages();
    this._host.requestUpdate();
  }

  /**
   * A landing page Home Assistant replaced can linger, in a lookup or kept
   * from one. Home Assistant OS shows it on another port than Home Assistant
   * itself, so one that answers on the same device means it is gone. Home
   * Assistants on different ports of a device are each their own.
   */
  private _forgetReplacedLandingPages() {
    const homeAssistants = new Set(
      [...this._entries.values()]
        .filter(({ announcement }) => !announcement.landing_page)
        .map(({ announcement }) => device(announcement.address))
    );
    for (const [address, { announcement }] of this._entries) {
      if (announcement.landing_page && homeAssistants.has(device(address))) {
        this._entries.delete(address);
      }
    }
  }
}

/** The device at `address`: its IPv4 address, without the port */
function device(address: string): string {
  return address.replace(/:\d+$/, "");
}

/**
 * Each address once. Home Assistant goes before a landing page there: it
 * replaces the landing page once installed, whose announcement can linger.
 */
function onePerAddress(announcements: HaAnnouncement[]): HaAnnouncement[] {
  const byAddress = new Map<string, HaAnnouncement>();
  for (const announcement of announcements) {
    const other = byAddress.get(announcement.address);
    if (!other || (other.landing_page && !announcement.landing_page)) {
      byAddress.set(announcement.address, announcement);
    }
  }
  return [...byAddress.values()];
}
