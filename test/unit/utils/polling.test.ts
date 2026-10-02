import { expect } from "@open-wc/testing";
import {
  CancelledError,
  PollTimeoutError,
  delay,
  isCancelled,
  pollUntil,
  throwIfCancelled,
} from "../../../src/utils/polling.js";

/** Options shared by the poll tests - short enough to keep the suite fast */
const pollOptions = (signal: AbortSignal, timeout = 1000) => ({
  interval: 5,
  timeout,
  signal,
  timeoutMessage: "timed out waiting for it",
});

describe("polling", () => {
  describe("throwIfCancelled", () => {
    it("does nothing while the signal is live", () => {
      const controller = new AbortController();
      expect(() => throwIfCancelled(controller.signal)).to.not.throw();
    });

    it("throws a CancelledError once aborted", () => {
      const controller = new AbortController();
      controller.abort();
      expect(() => throwIfCancelled(controller.signal)).to.throw(
        CancelledError
      );
    });
  });

  describe("isCancelled", () => {
    it("recognises a CancelledError", () => {
      expect(isCancelled(new CancelledError())).to.be.true;
    });

    it("does not recognise other errors", () => {
      expect(isCancelled(new Error("boom"))).to.be.false;
      expect(isCancelled(new PollTimeoutError("late"))).to.be.false;
      expect(isCancelled(undefined)).to.be.false;
    });
  });

  describe("delay", () => {
    it("resolves after the delay", async () => {
      const controller = new AbortController();
      await delay(1, controller.signal);
    });

    it("rejects immediately when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      let error: unknown;
      try {
        await delay(10_000, controller.signal);
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(CancelledError);
    });

    it("rejects as soon as the signal aborts, without waiting it out", async () => {
      const controller = new AbortController();
      const pending = delay(10_000, controller.signal);
      controller.abort();

      let error: unknown;
      try {
        await pending;
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(CancelledError);
    });
  });

  describe("pollUntil", () => {
    it("returns the first non-nullish result without sleeping", async () => {
      const controller = new AbortController();
      let calls = 0;

      const result = await pollUntil(async () => {
        calls++;
        return "192.168.1.10";
      }, pollOptions(controller.signal));

      expect(result).to.equal("192.168.1.10");
      expect(calls).to.equal(1);
    });

    it("keeps polling while the check returns null", async () => {
      const controller = new AbortController();
      let calls = 0;

      const result = await pollUntil(async () => {
        calls++;
        return calls < 2 ? null : true;
      }, pollOptions(controller.signal));

      expect(result).to.be.true;
      expect(calls).to.equal(2);
    });

    it("treats a throwing check as 'not ready yet' and retries", async () => {
      const controller = new AbortController();
      let calls = 0;

      const result = await pollUntil(async () => {
        calls++;
        if (calls < 2) {
          throw new Error("connection refused");
        }
        return "ready";
      }, pollOptions(controller.signal));

      expect(result).to.equal("ready");
      expect(calls).to.equal(2);
    });

    it("throws a PollTimeoutError instead of resolving when it never succeeds", async () => {
      const controller = new AbortController();
      let calls = 0;

      let error: unknown;
      try {
        // A timeout shorter than the interval allows exactly one attempt
        await pollUntil(
          async () => {
            calls++;
            return null;
          },
          { ...pollOptions(controller.signal), timeout: 1 }
        );
      } catch (e) {
        error = e;
      }

      expect(error).to.be.instanceOf(PollTimeoutError);
      expect((error as PollTimeoutError).message).to.equal(
        "timed out waiting for it"
      );
      expect(calls).to.equal(1);
    });

    it("does not run the check at all when already cancelled", async () => {
      const controller = new AbortController();
      controller.abort();
      let calls = 0;

      let error: unknown;
      try {
        await pollUntil(async () => {
          calls++;
          return null;
        }, pollOptions(controller.signal));
      } catch (e) {
        error = e;
      }

      expect(error).to.be.instanceOf(CancelledError);
      expect(calls).to.equal(0);
    });

    it("stops polling as soon as the signal aborts", async () => {
      const controller = new AbortController();
      let calls = 0;

      const pending = pollUntil(async () => {
        calls++;
        controller.abort();
        return null;
      }, pollOptions(controller.signal));

      let error: unknown;
      try {
        await pending;
      } catch (e) {
        error = e;
      }

      expect(error).to.be.instanceOf(CancelledError);
      expect(calls).to.equal(1);
    });

    it("discards a result that arrives after the signal aborted", async () => {
      const controller = new AbortController();

      let error: unknown;
      try {
        // Cancelled while the check was in flight, which then still succeeds
        await pollUntil(async () => {
          controller.abort();
          return "192.168.1.10";
        }, pollOptions(controller.signal));
      } catch (e) {
        error = e;
      }

      expect(error).to.be.instanceOf(CancelledError);
    });

    it("times out while a check hangs", async () => {
      const controller = new AbortController();

      let error: unknown;
      try {
        await pollUntil(
          () => new Promise<string>(() => {}),
          pollOptions(controller.signal, 20)
        );
      } catch (e) {
        error = e;
      }

      expect(error).to.be.instanceOf(PollTimeoutError);
    });

    it("rejects a result that only arrives after the deadline", async () => {
      const controller = new AbortController();
      let settledLate = false;

      let error: unknown;
      try {
        await pollUntil(
          () =>
            new Promise<string>((resolve) =>
              setTimeout(() => {
                settledLate = true;
                resolve("192.168.1.10");
              }, 40)
            ),
          pollOptions(controller.signal, 10)
        );
      } catch (e) {
        error = e;
      }

      expect(error).to.be.instanceOf(PollTimeoutError);
      // The poll gave up at the deadline rather than waiting for the check
      expect(settledLate).to.be.false;
    });

    it("cancels while a check is pending, without waiting for it", async () => {
      const controller = new AbortController();

      const pending = pollUntil(
        () => new Promise<string>(() => {}),
        pollOptions(controller.signal, 10_000)
      );
      setTimeout(() => controller.abort(), 5);

      let error: unknown;
      try {
        await pending;
      } catch (e) {
        error = e;
      }

      expect(error).to.be.instanceOf(CancelledError);
    });

    it("removes its abort listeners once it finishes", async () => {
      const controller = new AbortController();
      const { signal } = controller;
      let listeners = 0;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = ((...args: Parameters<typeof add>) => {
        listeners++;
        add(...args);
      }) as typeof signal.addEventListener;
      signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
        listeners--;
        remove(...args);
      }) as typeof signal.removeEventListener;

      let calls = 0;
      await pollUntil(async () => {
        calls++;
        return calls < 3 ? null : "done";
      }, pollOptions(signal));

      expect(listeners).to.equal(0);
    });

    it("propagates cancellation raised by the check itself", async () => {
      const controller = new AbortController();

      let error: unknown;
      try {
        await pollUntil(async () => {
          throw new CancelledError();
        }, pollOptions(controller.signal));
      } catch (e) {
        error = e;
      }

      expect(error).to.be.instanceOf(CancelledError);
    });
  });
});
