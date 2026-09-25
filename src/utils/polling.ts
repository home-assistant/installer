/**
 * Helpers for cancellable waiting and polling.
 *
 * Install flows poll the backend for minutes at a time, which needs two
 * guarantees the plain `for` loop + `setTimeout` pattern does not give:
 *
 * 1. The loop stops as soon as the view is detached (cancel or navigation),
 *    instead of running on and writing state on a detached component.
 * 2. A loop that never sees what it waits for reports a timeout, instead of
 *    silently falling through as if it had succeeded.
 */

/** Thrown when an operation is aborted through its `AbortSignal`. */
export class CancelledError extends Error {
  constructor(message = "Operation cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

/** Thrown by `pollUntil` when the deadline passes without a result. */
export class PollTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PollTimeoutError";
  }
}

/** Whether `error` was raised because an operation was cancelled. */
export function isCancelled(error: unknown): boolean {
  return error instanceof CancelledError;
}

/** Throw a `CancelledError` if `signal` has already been aborted. */
export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancelledError();
  }
}

/**
 * Wait `ms` milliseconds, rejecting with a `CancelledError` as soon as
 * `signal` is aborted rather than waiting out the remaining delay.
 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CancelledError());
      return;
    }

    let timer: ReturnType<typeof setTimeout>;

    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };

    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface PollOptions {
  /** Delay between attempts, in milliseconds. */
  interval: number;
  /** Give up after this many milliseconds. */
  timeout: number;
  /** Aborting this signal rejects the poll with a `CancelledError`. */
  signal: AbortSignal;
  /** Message for the `PollTimeoutError` thrown when the deadline passes. */
  timeoutMessage: string;
}

/**
 * Call `check` every `interval` milliseconds until it resolves to a value that
 * is neither `null` nor `undefined`, and return that value.
 *
 * Errors thrown by `check` mean "not ready yet" and are retried - what is being
 * polled for is usually unreachable when polling starts. Only cancellation and
 * the timeout end the loop early, and both throw, so a caller cannot mistake
 * either one for success.
 */
export async function pollUntil<T>(
  check: () => Promise<T | null | undefined>,
  { interval, timeout, signal, timeoutMessage }: PollOptions
): Promise<T> {
  throwIfCancelled(signal);

  const deadline = Date.now() + timeout;

  for (;;) {
    try {
      const result = await check();
      if (result !== null && result !== undefined) {
        return result;
      }
    } catch (error) {
      if (isCancelled(error)) {
        throw error;
      }
      // Anything else is "not ready yet" - keep polling until the deadline.
    }

    throwIfCancelled(signal);

    // Stop before a sleep that would take us past the deadline.
    if (Date.now() + interval > deadline) {
      throw new PollTimeoutError(timeoutMessage);
    }

    await delay(interval, signal);
  }
}
