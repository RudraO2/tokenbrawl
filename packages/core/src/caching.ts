import type { MatchDecisionEntry } from './match-runner';

/**
 * Story 3.5: per-Agent cache accounting for one Match (AC3, AC5). Computed
 * from the in-memory `MatchDecisionEntry` list `runMatch` builds -- never
 * from a `CommandLog`, since `cachedTokens` cannot live on a frozen
 * `DecisionEntry` (`additionalProperties: false`).
 */
export interface CacheStats {
  readonly agentIndex: 0 | 1;
  readonly agentId: string;
  /** Decision Points this Agent was actually billed for (a Baseline Bot, or a `tokensSpent: null` probe result, never counts). */
  readonly billableCalls: number;
  /** Sum of `tokensSpent` across billable calls. */
  readonly totalTokens: number;
  /** Sum of tokens the provider reported as served from cache and excluded from the debit. */
  readonly cachedTokens: number;
  /** `cachedTokens / totalTokens`, or `0` when `totalTokens` is 0 -- never `NaN`. */
  readonly cacheHitRate: number;
  /** Billable calls where the provider reported no cache signal at all -- charged in full, conservatively (AC5). */
  readonly conservativeDebitCalls: number;
}

interface CacheBucket {
  billable: number;
  total: number;
  cached: number;
  conservative: number;
}

function emptyBucket(): CacheBucket {
  return { billable: 0, total: 0, cached: 0, conservative: 0 };
}

/**
 * Aggregates cache accounting per Agent over one Match. Pure: one pass over
 * `decisions`, no I/O. A decision with `tokensSpent` absent or `null` -- a
 * Baseline Bot's entry, or a Deployment's Metering-Probe-style "no usage
 * reported" call -- contributes nothing, since nothing was billed.
 */
export function computeCacheStats(
  decisions: readonly MatchDecisionEntry[],
  agentIds: readonly [string, string],
): readonly [CacheStats, CacheStats] {
  const buckets: [CacheBucket, CacheBucket] = [emptyBucket(), emptyBucket()];

  for (const entry of decisions) {
    if (entry.tokensSpent === undefined || entry.tokensSpent === null) {
      continue;
    }

    const bucket = buckets[entry.agentIndex];
    bucket.billable += 1;
    bucket.total += entry.tokensSpent;

    if (entry.cachedTokens === undefined || entry.cachedTokens === null) {
      bucket.conservative += 1;
    } else {
      bucket.cached += entry.cachedTokens;
    }
  }

  const statFor = (agentIndex: 0 | 1): CacheStats => {
    const bucket = buckets[agentIndex];
    return {
      agentIndex,
      agentId: agentIds[agentIndex],
      billableCalls: bucket.billable,
      totalTokens: bucket.total,
      cachedTokens: bucket.cached,
      cacheHitRate: bucket.total === 0 ? 0 : bucket.cached / bucket.total,
      conservativeDebitCalls: bucket.conservative,
    };
  };

  return [statFor(0), statFor(1)];
}

/**
 * Human-readable deviation notes (AC5: "the deviation is logged per
 * Deployment and published") for every Agent that had at least one
 * conservatively-billed call. Empty for a Match where every billed call
 * carried cache signal, or where nothing was billed at all.
 */
export function formatCacheDeviations(stats: readonly CacheStats[]): readonly string[] {
  return stats
    .filter((stat) => stat.conservativeDebitCalls > 0)
    .map(
      (stat) =>
        `${stat.agentId}: ${stat.conservativeDebitCalls} of ${stat.billableCalls} call(s) billed conservatively -- no cache signal reported by the provider.`,
    );
}
