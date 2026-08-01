/**
 * Story 4.3, AC1: which Decision Point a playback position actually refers to.
 *
 * "The reasoning shown is for the Decision Point at that exact position — not
 * the nearest neighbour." That sentence has a trap in it, and the trap is the
 * whole reason this module exists.
 *
 * A Decision Point is `(tick, agentIndex)`, and a playback frame carries the
 * Decision Point index it sits inside, so the tick is
 * `decisionPoint * ticksPerDecision`. Exact, no arithmetic to get wrong.
 *
 * But a fighter inside a Commitment Window **is not polled at all**. Its
 * `isActionable` is false, `runMatch` never asks it for an Action, and the log
 * therefore carries no entry at that tick. An `attack` window is 40 ticks
 * against a 30-tick Decision Point, so this is not a corner case -- on the
 * committed demo Match a large share of positions have no decision at their own
 * tick, including the last one the replay rests on.
 *
 * Reaching for the closest logged entry there is exactly what AC1 forbids, and
 * it would be wrong in a specific way: the *next* Decision Point's reasoning
 * has not happened yet at this position, and picking whichever is nearer means
 * the panel sometimes shows a decision from the future.
 *
 * So this module answers a different question, and the engine's own semantics
 * make it the exact one: **which decision is this fighter still executing?**
 * A committed fighter is carrying out an Action it chose at an earlier
 * Decision Point; naming that Decision Point and saying the fighter is still
 * committed to it is a true statement about this position, not an approximation
 * of one. The search only ever walks backwards, never forwards, and never
 * crosses to the other Agent's history.
 */

export interface ResolvedDecision {
  /** The tick whose decision governs this fighter at this playback position. */
  readonly tick: number;
  /** Which Decision Point that tick is. */
  readonly decisionPoint: number;
  /**
   * True when the Agent was polled at exactly the position asked about.
   *
   * False means it was mid-Commitment-Window and the tick above is the
   * decision it is still carrying out. The distinction is displayed, never
   * smoothed over -- a viewer who is not told would reasonably read a
   * commitment as a fresh choice.
   */
  readonly polled: boolean;
}

/**
 * Resolves a playback position to the Decision Point that governs one fighter.
 *
 * `wasPolled` is injected rather than a log being passed in: the only fact this
 * needs is whether an entry exists for a `(tick, agentIndex)` pair, the caller
 * already has a reader that answers exactly that, and keeping the log out of
 * here is what lets every case below be written against a two-line predicate.
 *
 * Returns `null` when the Agent has not been polled at or before this position
 * -- reachable at the very start of a Match, and a state the panel must have
 * copy for rather than rendering an empty box.
 */
export function resolveDecision(
  decisionPoint: number,
  agentIndex: 0 | 1,
  wasPolled: (tick: number, agentIndex: 0 | 1) => boolean,
  ticksPerDecision: number,
): ResolvedDecision | null {
  if (!Number.isSafeInteger(decisionPoint) || decisionPoint < 0) {
    return null;
  }
  if (!Number.isSafeInteger(ticksPerDecision) || ticksPerDecision <= 0) {
    throw new Error(
      `resolveDecision: ticksPerDecision must be a positive safe integer, got ${String(ticksPerDecision)}.`,
    );
  }

  for (let candidate = decisionPoint; candidate >= 0; candidate -= 1) {
    const tick = candidate * ticksPerDecision;
    if (wasPolled(tick, agentIndex)) {
      return Object.freeze({
        tick,
        decisionPoint: candidate,
        polled: candidate === decisionPoint,
      });
    }
  }

  return null;
}
