import { wizardState } from "../../state/wizard-state.js";

/** Lookups report an expired session as its own code, answered with Reconnect */
export const SESSION_EXPIRED = "proxmox_session_expired";

/**
 * A changed certificate needs the same answer: reconnecting shows the new
 * certificate to confirm, while retrying would keep hitting the old pin.
 */
const CERTIFICATE_CHANGED = "proxmox_certificate_changed";

/** Whether only logging in again can get past `error`. */
export function needsReconnect(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === SESSION_EXPIRED || error.code === CERTIFICATE_CHANGED)
  );
}

/**
 * Drop the session that stopped working. Its server stays, so the connect
 * step starts from it and notices a different certificate.
 */
export function forgetProxmoxSession() {
  const session = wizardState.getState().selections.proxmoxSession;
  if (session) {
    wizardState.setSelection("proxmoxPreviousServer", {
      server_url: session.server_url,
      certificate_sha256: session.certificate_sha256,
    });
  }
  wizardState.setSelection("proxmoxSession", undefined);
  wizardState.setSelection("proxmoxConnected", false);
}
