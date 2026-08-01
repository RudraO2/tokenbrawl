import type { RateLimitSignal } from '../../providers/src/rate-limit';

/**
 * Story 5.2: quota bookkeeping and Deployment parking.
 *
 * AD-9 puts this state in the runner, never in an adapter -- and this module
 * is why that has teeth rather than being a comment. `agents.ts` builds a
 * fresh `ProviderClient` for every Match (never a shared one), so nothing at
 * the adapter layer can remember that a Deployment was rate-limited two
 * Matches ago. Only something the tournament constructs once, before the
 * first Match, and threads through every one of them can -- and this is that
 * thing. It is also the only place in the package that decides a Deployment
 * is done for the day.
 *
 * What it deliberately does not do: sleep. Every adapter (`groq.ts`,
 * `cerebras.ts`, `google.ts`) already sleeps `min(retryAfterMs, maxBackoffMs)`
 * inside `complete()` before resolving -- that is Story 3.2's AC4, already
 * shipped, and re-implementing it here would be a second backoff clock
 * disagreeing with the first. What Story 3.2 could not do, because it is
 * scoped to one call, is notice that `retryAfterMs` was *larger* than
 * `maxBackoffMs` -- meaning the account is still rate-limited after the
 * adapter's own bounded wait, and every further call this run would just
 * spend another request confirming that. That is the runner's decision to
 * make, and it is the one thing this module exists for.
 */

export interface QuotaTracker {
  /** Whether this Deployment has been parked for the remainder of this run. */
  isParked(agentId: string): boolean;

  /** Every Deployment id parked so far, in the order it happened. */
  readonly parked: readonly string[];

  /**
   * Records a rate-limit signal for a Deployment.
   *
   * `maxBackoffMs` is the provider's own bound on how long one call may block
   * (`FreeTierProvider.maxBackoffMs`) -- the adapter has already slept
   * `min(signal.retryAfterMs, maxBackoffMs)` by the time this runs. A
   * `retryAfterMs` at or under that bound was therefore already waited out in
   * full and needs nothing further here. A `retryAfterMs` *past* it is the
   * tell: one call's bounded wait could not clear it, which is what a
   * daily-quota exhaustion looks like from a response header (a per-minute
   * reset is gone long before an hour, let alone a `maxBackoffMs` measured in
   * seconds). The Deployment is parked instead of retried.
   *
   * Returns `true` exactly on the call that parks the Deployment -- never
   * again for the same id, and never for a signal that did not cross the
   * threshold.
   */
  recordRateLimit(agentId: string, signal: RateLimitSignal, maxBackoffMs: number): boolean;
}

export function createQuotaTracker(): QuotaTracker {
  const parkedSet = new Set<string>();
  const parkedOrder: string[] = [];

  return Object.freeze({
    isParked(agentId: string): boolean {
      return parkedSet.has(agentId);
    },

    get parked(): readonly string[] {
      return Object.freeze([...parkedOrder]);
    },

    recordRateLimit(agentId: string, signal: RateLimitSignal, maxBackoffMs: number): boolean {
      if (parkedSet.has(agentId) || signal.retryAfterMs <= maxBackoffMs) {
        return false;
      }
      parkedSet.add(agentId);
      parkedOrder.push(agentId);
      return true;
    },
  });
}
