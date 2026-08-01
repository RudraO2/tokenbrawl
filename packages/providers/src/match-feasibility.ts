import type { FreeTierLimits } from './free-tier';

/**
 * Story 4.7: can this model finish one Match, and roughly how long will it take?
 *
 * Story 4.6 shipped a picker offering `gemini-2.5-flash`, which has a
 * **20-request daily cap** against a Match that costs up to sixty calls. It can
 * never complete one. Deleting that row fixes today; this file is the part that
 * fixes the next one, because the fact was always derivable from the numbers
 * already in `free-tier.config.json` and nothing was doing the division.
 *
 * The arithmetic is the report's own (`docs/reports/byok-provider-limits.md`,
 * the section titled "The number that actually binds"):
 *
 * - Up to two provider calls per Decision Point, roughly thirty Decision Points,
 *   minus every point where a fighter is inside a Commitment Window and is not
 *   polled. **Sixty calls worst case**, about forty-five typical. Sixty is used
 *   because a picker that promises a Match can be run must be right about the
 *   worst case, not the median.
 * - **RPD decides whether a fight can finish at all.** `RPD / 60` is Matches per
 *   day, and zero means the model must not be offered as runnable.
 * - **TPM and RPM each bound how long it takes**, and the larger of the two
 *   binds. Groq's 8B row is 30 RPM but 6K TPM, so tokens bind at ten minutes;
 *   Cerebras is 30K TPM but 5 RPM, so requests bind at twelve.
 *
 * Every value below is an integer and every division is floored or ceiled
 * explicitly. That is not this package's invariant -- `audit-invariants.sh`
 * sweeps `packages/core` and `packages/env-*` for floats, not here -- but a
 * "4.8 Matches a day" in a picker is a number nobody can act on, and rounding at
 * the point of display rather than the point of computation is how two callers
 * end up disagreeing about whether a model is runnable.
 */

/**
 * The worst case, not the average. Two calls per Decision Point across about
 * thirty of them, less the points where a Commitment Window means a fighter is
 * not polled at all.
 */
export const MATCH_WORST_CASE_CALLS = 60;

/**
 * Tokens one call costs, near enough. The report's minutes-per-match column is
 * computed with the same figure, which is what lets the tests below check this
 * module against a table a human wrote from a dashboard.
 */
export const MATCH_TOKENS_PER_CALL = 1000;

/**
 * Where "this will take a while" starts, in minutes.
 *
 * Ten rather than something larger because it is roughly the point at which a
 * visitor who was told nothing would assume the page had hung. AC2 asks for the
 * fact *before* the visitor starts; the threshold only decides how loudly.
 */
export const SLOW_MATCH_MINUTES = 10;

/** Which of the two ceilings actually decides the duration. Displayed, so the number is explicable. */
export type FeasibilityBound = 'requests' | 'tokens';

export interface MatchFeasibility {
  /** `floor(RPD / 60)`. Zero means this model cannot complete a single Match. */
  readonly matchesPerDay: number;
  /** The larger of the request-rate and token-rate lower bounds, in whole minutes. */
  readonly minutesPerMatch: number;
  readonly runnable: boolean;
  readonly slow: boolean;
  readonly boundBy: FeasibilityBound;
}

/** Integer division that rounds up. `Math.ceil` on a quotient would go through a float first. */
function divideRoundingUp(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator - 1) / denominator);
}

export function matchFeasibility(limits: FreeTierLimits): MatchFeasibility {
  const matchesPerDay = Math.floor(limits.requestsPerDay / MATCH_WORST_CASE_CALLS);

  const minutesByRequests = divideRoundingUp(MATCH_WORST_CASE_CALLS, limits.requestsPerMinute);
  const minutesByTokens = divideRoundingUp(
    MATCH_WORST_CASE_CALLS * MATCH_TOKENS_PER_CALL,
    limits.tokensPerMinute,
  );
  const minutesPerMatch = Math.max(minutesByRequests, minutesByTokens);

  return Object.freeze({
    matchesPerDay,
    minutesPerMatch,
    runnable: matchesPerDay >= 1,
    slow: minutesPerMatch >= SLOW_MATCH_MINUTES,
    // Ties go to requests: when both ceilings land on the same minute the
    // request rate is the one a visitor can see happening.
    boundBy: minutesByRequests >= minutesByTokens ? 'requests' : 'tokens',
  });
}

/**
 * The sentence a picker puts beside a model, or `''` when there is nothing
 * unusual to say.
 *
 * Two cases earn text and no others. A model that cannot finish a Match is the
 * whole reason this story exists, and one that takes ten minutes or more is the
 * thing 4.6 let a visitor discover halfway through. Everything else is already
 * carried by the RPM/RPD shown on the option itself.
 */
export function feasibilityNotice(limits: FreeTierLimits): string {
  const feasibility = matchFeasibility(limits);

  if (!feasibility.runnable) {
    return `Cannot finish one Match: ${String(limits.requestsPerDay)} requests a day against up to ${String(MATCH_WORST_CASE_CALLS)} calls per Match.`;
  }

  if (feasibility.slow) {
    const because =
      feasibility.boundBy === 'requests'
        ? `${String(limits.requestsPerMinute)} requests a minute`
        : `${String(limits.tokensPerMinute)} tokens a minute`;
    return `Slow: about ${String(feasibility.minutesPerMatch)} minutes for one Match, limited by ${because}.`;
  }

  return '';
}
