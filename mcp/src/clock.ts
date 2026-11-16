/** Injectable time source so that waiting/timeout logic is unit-testable. */
export interface Clock {
  /** Milliseconds since an arbitrary epoch (monotonic enough for deadlines). */
  now(): number;
  /** Resolves after `ms`. Rejects with an AbortError if `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function abortError(message = "The operation was aborted"): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, ms));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};
