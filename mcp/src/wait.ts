import { CloudAuthError } from "./cloud-auth.ts";
import type { Clock } from "./clock.ts";
import { RelayError, type RelayClient, type RelayRequest } from "./relay-client.ts";

/** One long-poll never asks the relay to block longer than this (PROTOCOL.md section 9). */
export const MAX_POLL_SECONDS = 30;

export interface WaitOptions {
  clock: Clock;
  /** Total time budget in seconds (already clamped to 0-3600). */
  waitSeconds: number;
  signal?: AbortSignal | undefined;
  /**
   * Latest known state (e.g. the freshly created request). When given, a budget of 0 performs no
   * HTTP call at all; when omitted, at least one GET is made so the current state is always returned.
   */
  initial?: RelayRequest | undefined;
  /** Called after every poll cycle that ended with the request still pending. */
  onPoll?: ((info: { elapsedSeconds: number; waitSeconds: number }) => void) | undefined;
  /** Delays before retrying a transient failure; its length is the max number of consecutive retries. */
  retryBackoffMs?: readonly number[] | undefined;
  /** Minimum duration of a poll cycle; guards against a relay that returns "pending" instantly. */
  minCycleMs?: number | undefined;
}

export const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [1000, 2000, 4000];

/**
 * Repeatedly long-polls `GET /v1/requests/{id}?wait=` (at most 30s each) until the request leaves
 * `pending` or the time budget is used up. Returns the latest state, which may still be `pending`.
 *
 * Transient failures (relay unreachable, timeout, 5xx, garbage body) are retried with backoff once
 * the request is known to exist (i.e. after a successful create or poll in this call), because the
 * relay may simply be restarting. Other failures (401/403/404/...) are thrown immediately.
 */
export async function waitForResolution(client: RelayClient, requestId: string, options: WaitOptions): Promise<RelayRequest> {
  const { clock, signal } = options;
  const backoff = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const minCycleMs = options.minCycleMs ?? 1000;
  const startedAt = clock.now();
  const deadline = startedAt + options.waitSeconds * 1000;

  let latest = options.initial;
  if (latest && latest.status !== "pending") return latest;

  let failures = 0;
  let lastError: RelayError | CloudAuthError | undefined;

  for (;;) {
    const remainingMs = deadline - clock.now();
    if (remainingMs <= 0 && latest) break;

    const wait = Math.min(MAX_POLL_SECONDS, Math.max(0, Math.ceil(remainingMs / 1000)));
    const cycleStart = clock.now();
    try {
      latest = await client.getRequest(requestId, { waitSeconds: wait, signal });
      failures = 0;
      lastError = undefined;
    } catch (e) {
      if (!(e instanceof RelayError || e instanceof CloudAuthError) || !e.transient || !latest) throw e;
      lastError = e;
      const delay = backoff[failures];
      failures += 1;
      if (delay === undefined) throw e;
      const left = deadline - clock.now();
      if (left <= 0) throw e;
      await clock.sleep(Math.min(delay, left), signal);
      continue;
    }

    if (latest.status !== "pending") return latest;
    options.onPoll?.({
      elapsedSeconds: Math.round((clock.now() - startedAt) / 1000),
      waitSeconds: options.waitSeconds,
    });

    const cycleMs = clock.now() - cycleStart;
    const left = deadline - clock.now();
    if (wait > 0 && cycleMs < minCycleMs && left > 0) {
      await clock.sleep(Math.min(minCycleMs - cycleMs, left), signal);
    }
  }

  if (lastError) throw lastError;
  return latest;
}
