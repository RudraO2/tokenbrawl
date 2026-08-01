import type { HttpHeaders } from '../../../../packages/providers/src/http';
import { MATCH_TOKENS_PER_CALL } from '../../../../packages/providers/src/match-feasibility';
import { parseDurationMs } from '../../../../packages/providers/src/rate-limit';

/**
 * Story 4.8: the quota arithmetic behind a BYOK Match that paces itself.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS HERE AND NOT IN `packages/providers/src/rate-limit.ts`
 * ---------------------------------------------------------------------------
 *
 * The story's Scope line says the waiting and the pacing belong to the BYOK
 * runner, and that reading headers into a typed signal "is already
 * `rate-limit.ts`'s job and **may** be extended there". It is not extended
 * there, and the permissive "may" is being read deliberately.
 *
 * The last acceptance criterion is that `git diff` shows no change to any
 * adapter's rate-limit path. Putting one exported function into
 * `rate-limit.ts` would make that criterion an argument about which files count
 * as an adapter. Putting all of it here makes `git diff -- packages` **empty**,
 * which is a one-command proof instead of an argument -- and `parseDurationMs`,
 * `MATCH_TOKENS_PER_CALL` and `defaultSleep` are all already exported, so
 * nothing had to be widened to reach them.
 *
 * ---------------------------------------------------------------------------
 * INV-3, at the source rather than at the display
 * ---------------------------------------------------------------------------
 *
 * Every millisecond this file produces is derived from a *quota* header --
 * "when does the token bucket refill" -- and never from how long a model took to
 * answer. That is what makes it safe for a paced Match to take longer than an
 * unpaced one without any of it leaking into what a visitor sees. The panel
 * still shows a state and a count of completed calls and nothing else; the
 * numbers below never reach the page.
 *
 * ---------------------------------------------------------------------------
 * INV-2: none of this may touch outcome
 * ---------------------------------------------------------------------------
 *
 * A wait delays a call. It does not change the request, the response, the
 * ordering of the two fighters (`runMatch` awaits both Decisions before it
 * steps), the seed, or the Token Bank. A paced Match and an unpaused one produce
 * byte-identical Command Logs, and `run.test.ts` asserts exactly that by
 * comparing two serialised logs rather than by trusting this paragraph.
 */

/**
 * The longest wait worth taking, in milliseconds.
 *
 * Ninety seconds sits in the gap the providers themselves leave: every
 * per-minute bucket (`x-ratelimit-reset-tokens` on Groq is single-digit
 * seconds; a `retry-after` on a TPM trip is tens of seconds) clears well inside
 * it, and every *daily* bucket resets hours away. So the one comparison
 * separates "wait, this will clear" from "this key is done for the day", with no
 * need to classify which quota tripped from prose.
 *
 * A wait that cannot succeed is worse than a failure: the visitor stares at a
 * tab for six hours instead of being told to come back tomorrow.
 */
export const MAX_WAIT_MS = 90_000;

/**
 * How many times a Match may wait on a 429 before it is abandoned, across both
 * fighters.
 *
 * Only *reactive* waits are counted, and the difference is whether progress was
 * made. A 429 wait makes none -- the same call is about to be issued again, and
 * unbounded that is an infinite loop. A *paced* wait follows a call that
 * succeeded, so the Match has advanced and will terminate at `maxTicks`
 * regardless; the number of paced waits is already bounded by the length of a
 * Match. Counting them here would abandon a Cerebras Match, where 5 RPM means
 * roughly sixty paced waits and every one of them is the feature working.
 *
 * Eight rather than something larger because pacing is supposed to prevent
 * these. Eight 429s in one Match means the pacing signal is absent or wrong, and
 * a ninth wait is not going to be the one that fixes it.
 */
export const MAX_RATE_LIMIT_WAITS = 8;

/**
 * What a response said about the quota it just spent.
 *
 * `null` means the provider reported nothing, which is the common case outside
 * Groq -- and it is the reason reactive waiting stays the floor rather than
 * being replaced by pacing. Never coerced to zero: "no headroom left" and "no
 * information" are opposite instructions.
 */
export interface QuotaSnapshot {
  readonly remainingRequests: number | null;
  readonly remainingTokens: number | null;
  readonly resetRequestsMs: number | null;
  readonly resetTokensMs: number | null;
}

/**
 * What a client knows before its first call, and what it goes back to after a
 * wait: nothing. A wait is exactly long enough for the bucket it was reading to
 * refill, so keeping the reading that caused it would pace a second time on a
 * number that is stale by construction.
 */
export const NO_QUOTA_REPORTED: QuotaSnapshot = Object.freeze({
  remainingRequests: null,
  remainingTokens: null,
  resetRequestsMs: null,
  resetTokensMs: null,
});

/** A whole non-negative count, or `null` for absent, blank or unreadable. */
function readCount(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * The four headers Groq documents and returns on **every** response, not only on
 * a 429. That is the whole reason proactive pacing is possible at all: a limit
 * can be seen coming rather than absorbed.
 *
 * The reset values go through `parseDurationMs`, which already reads the forms
 * these endpoints actually emit (`7.66s`, `2m59.56s`, `430ms`) and rounds up.
 */
export function readQuotaHeaders(headers: HttpHeaders): QuotaSnapshot {
  return Object.freeze({
    remainingRequests: readCount(headers.get('x-ratelimit-remaining-requests')),
    remainingTokens: readCount(headers.get('x-ratelimit-remaining-tokens')),
    resetRequestsMs: parseDurationMs(headers.get('x-ratelimit-reset-requests')),
    resetTokensMs: parseDurationMs(headers.get('x-ratelimit-reset-tokens')),
  });
}

/**
 * How long to hold before the next call, from what the last response said.
 *
 * A bucket that cannot cover one more call is the trigger, not a percentage:
 * the next call costs about `MATCH_TOKENS_PER_CALL` tokens and exactly one
 * request, so "fewer than that remain" is the precise statement of *this call
 * will be refused*. Pacing at some fraction of the bucket would slow every Match
 * down to avoid a 429 that was never going to happen.
 *
 * A missing reset beside an exhausted bucket yields `0` rather than a guess. The
 * call then goes out, is refused, and the 429's own `retry-after` -- which is
 * information rather than invention -- decides the wait.
 *
 * Both buckets are consulted and the **later** reset wins, for the same reason
 * `retryAfterMsFrom` takes the later of the two: clearing only the nearer one
 * puts the next call straight back into a refusal.
 */
export function paceBeforeNextCallMs(snapshot: QuotaSnapshot): number {
  const waits: number[] = [];

  if (snapshot.remainingTokens !== null && snapshot.remainingTokens < MATCH_TOKENS_PER_CALL) {
    waits.push(snapshot.resetTokensMs ?? 0);
  }
  if (snapshot.remainingRequests !== null && snapshot.remainingRequests < 1) {
    waits.push(snapshot.resetRequestsMs ?? 0);
  }

  return waits.length === 0 ? 0 : Math.max(0, ...waits);
}

/**
 * Whether a wait of this length can plausibly clear.
 *
 * `false` is how a daily cap is recognised without reading anybody's prose: an
 * RPD bucket resets hours away and a per-minute one resets in seconds, and no
 * provider sits between the two.
 */
export function isWaitable(waitMs: number): boolean {
  return Number.isFinite(waitMs) && waitMs <= MAX_WAIT_MS;
}

/**
 * The Match's allowance of reactive waits, shared by both fighters.
 *
 * Shared rather than one each, because the bound is a statement about the
 * *Match*: two keys each stalling four times is the same amount of nothing
 * happening as one key stalling eight times, and a per-fighter budget would let
 * a two-sided stall run twice as long as a one-sided one for no reason.
 */
export interface WaitBudget {
  /** Records one reactive wait. `false` once the bound has been passed. */
  readonly spend: () => boolean;
  readonly taken: () => number;
}

export function createWaitBudget(limit: number = MAX_RATE_LIMIT_WAITS): WaitBudget {
  // A counter object rather than a mutable binding: a shipped file here may
  // declare no module-level `let`, and this has to be per-Match state anyway.
  const state = { spent: 0 };
  return Object.freeze({
    spend: (): boolean => {
      if (state.spent >= limit) {
        return false;
      }
      state.spent += 1;
      return true;
    },
    taken: (): number => state.spent,
  });
}
