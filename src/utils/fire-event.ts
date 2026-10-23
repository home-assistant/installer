declare global {
  /**
   * The app's own events, by name, with the detail each carries: `undefined`
   * for none. The module that sends one adds it here, so the sender and its
   * listeners agree on both.
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- The senders fill it in.
  interface HAIEvents {}

  // So `addEventListener` knows them too
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- The members come from HAIEvents.
  interface HTMLElementEventMap extends HAIEventMap {}
}

/** One of the app's own events, as its listeners receive it */
export type HAIEvent<K extends keyof HAIEvents> = CustomEvent<HAIEvents[K]>;

type HAIEventMap = { [K in keyof HAIEvents]: HAIEvent<K> };

/**
 * Send `type` from `target`, with its detail if it has one. It bubbles out of
 * shadow roots too, so the shell hears it however deep the sender sits.
 */
export function fireEvent<K extends keyof HAIEvents>(
  target: EventTarget,
  type: K,
  ...[detail]: HAIEvents[K] extends undefined ? [] : [detail: HAIEvents[K]]
) {
  target.dispatchEvent(
    new CustomEvent(type, { detail, bubbles: true, composed: true })
  );
}
