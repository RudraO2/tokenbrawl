/**
 * Story 7.1 AC4: the side advantage in an Environment, measured from results
 * rather than assumed away.
 *
 * `mirrored-seed.test.ts` (Story 2.2) proves the *engine* is symmetric for one
 * scripted seed with jitter configured off. This is the corpus-level statement
 * of the same claim: across every mirrored pair actually played, does side 0
 * score better than side 1, and by how much, with an interval.
 *
 * ## Why mirrored pairs and not all Matches
 *
 * Averaging side-0 score over every Match confounds two things: whether side 0
 * is advantaged, and whether the Agents who happened to play side 0 were
 * stronger. Inside one mirrored pair -- the same two Agents, the same seed,
 * swapped -- each Agent appears once on each side, so skill cancels exactly and
 * what is left is the side. That is the whole reason AD-12 makes a side swap a
 * separate Match.
 *
 * The pair's score is `floor((x + y) / 2)`, where `x` is side 0's score in the
 * Match with `pairing[0]` on side 0 and `y` is side 0's score in its mirror.
 * Both are in `{0, 5000, 10000}`, so a pair scores in
 * `{0, 2500, 5000, 7500, 10000}` -- integers throughout, which INV-2's ban on
 * floating point in this package requires and which also makes the report
 * reproduce bit for bit.
 *
 * ## Why the bootstrap resamples pairs
 *
 * The two Matches of a pair are not independent observations; their dependence
 * is the point. Resampling Matches individually would report an interval
 * narrower than the data supports, which for a *null* claim ("no side
 * advantage detected") is the direction that misleads.
 *
 * `meanBasisPoints` floors rather than rounds, house-wide, so the reported
 * advantage is biased by at most 1 basis point toward side 1. Left uncorrected
 * deliberately: a second rounding rule in a package with exactly one is worse
 * than a known 1-part-in-10000 conservatism on a number whose whole job is to
 * be compared against zero.
 */

import {
  DRAW_BASIS_POINTS,
  LOSS_BASIS_POINTS,
  WIN_BASIS_POINTS,
  bootstrapMeanInterval,
  meanBasisPoints,
  type BootstrapInterval,
} from './statistics';

/** A side-neutral Environment scores side 0 at exactly this over mirrored pairs. */
export const NEUTRAL_SIDE_SCORE_BASIS_POINTS = DRAW_BASIS_POINTS;

export interface SideAdvantageMatch {
  readonly seed: number;
  /** Side 0 first. Array index 0 is P1; there is no "sides swapped" flag (AD-12). */
  readonly agentIds: readonly [string, string];
  /** 10000 side 0 won, 5000 draw, 0 side 1 won. */
  readonly side0ScoreBasisPoints: number;
}

export interface MirroredPair {
  /** The two Agent ids, sorted. */
  readonly pairing: readonly [string, string];
  readonly seed: number;
  /** floor((x + y) / 2) over the pair's two Matches. Skill cancels; a side advantage does not. */
  readonly side0ScoreBasisPoints: number;
}

export interface SideAdvantageSummary {
  readonly matches: number;
  readonly mirroredPairs: number;
  /**
   * Matches belonging to no complete mirrored pair, and therefore excluded
   * from the estimate. Reported rather than dropped in silence: a corpus that
   * is mostly unpaired is a scheduling failure, and the number is how it gets
   * noticed.
   */
  readonly unpairedMatches: number;
  readonly pairs: readonly MirroredPair[];
  /** Mean side-0 score over mirrored pairs. 5000 is neutral. */
  readonly side0ScoreBasisPoints: number;
  /** Signed: positive favours side 0, negative favours side 1. */
  readonly advantageBasisPoints: number;
  readonly interval: BootstrapInterval;
  /** True when the interval excludes 5000 entirely -- a side advantage the data supports. */
  readonly detected: boolean;
}

export interface SideAdvantageParams {
  readonly matches: readonly SideAdvantageMatch[];
  readonly resamples: number;
  readonly seed: number;
  readonly confidenceBasisPoints?: number;
}

/** Score side 0 from a terminal outcome, so callers never hand-roll the mapping. */
export function side0Score(outcome: 'p1' | 'p2' | 'draw'): number {
  if (outcome === 'p1') {
    return WIN_BASIS_POINTS;
  }
  if (outcome === 'p2') {
    return LOSS_BASIS_POINTS;
  }
  return DRAW_BASIS_POINTS;
}

function sortedPairing(agentIds: readonly [string, string]): readonly [string, string] {
  return agentIds[0].localeCompare(agentIds[1]) <= 0
    ? [agentIds[0], agentIds[1]]
    : [agentIds[1], agentIds[0]];
}

function assertMatch(match: SideAdvantageMatch, index: number): void {
  if (!Number.isSafeInteger(match.seed)) {
    throw new Error(
      `summariseSideAdvantage: match ${String(index)} has a non-integer seed: ${String(match.seed)}`,
    );
  }
  if (match.agentIds[0] === match.agentIds[1]) {
    throw new Error(
      `summariseSideAdvantage: match ${String(index)} pairs "${match.agentIds[0]}" with itself, which has no sides to compare`,
    );
  }
  if (
    !Number.isSafeInteger(match.side0ScoreBasisPoints) ||
    match.side0ScoreBasisPoints < LOSS_BASIS_POINTS ||
    match.side0ScoreBasisPoints > WIN_BASIS_POINTS
  ) {
    throw new Error(
      `summariseSideAdvantage: match ${String(index)} scores side 0 at ${String(match.side0ScoreBasisPoints)}, outside 0..${String(WIN_BASIS_POINTS)} basis points`,
    );
  }
}

interface SeedGroup {
  readonly pairing: readonly [string, string];
  readonly seed: number;
  /** Side-0 scores of Matches with `pairing[0]` on side 0, then with `pairing[1]` on side 0. */
  readonly byOrientation: [number[], number[]];
}

/**
 * The complete mirrored pairs in a corpus, and how many Matches were left over.
 *
 * A group is a pair only when it holds exactly one Match in each orientation.
 * A group with two Matches of one orientation and none of the other is *not*
 * half of two pairs; it is two unpaired Matches, and counting it otherwise
 * would smuggle a one-sided sample into an estimator whose entire premise is
 * that skill cancels. Surplus Matches beyond the first of each orientation are
 * counted as unpaired for the same reason: pairing them arbitrarily would make
 * the estimate depend on input order.
 */
function collectPairs(matches: readonly SideAdvantageMatch[]): {
  pairs: MirroredPair[];
  unpaired: number;
} {
  const groups = new Map<string, SeedGroup>();

  matches.forEach((match, index) => {
    assertMatch(match, index);
    const pairing = sortedPairing(match.agentIds);
    const key = `${pairing[0]} ${pairing[1]} ${String(match.seed)}`;
    const group = groups.get(key) ?? { pairing, seed: match.seed, byOrientation: [[], []] };
    const memberOnSide0 = match.agentIds[0] === pairing[0] ? 0 : 1;
    group.byOrientation[memberOnSide0].push(match.side0ScoreBasisPoints);
    groups.set(key, group);
  });

  const pairs: MirroredPair[] = [];
  let unpaired = 0;

  for (const group of groups.values()) {
    const [first, second] = group.byOrientation;
    if (first.length !== 1 || second.length !== 1) {
      unpaired += first.length + second.length;
      continue;
    }
    pairs.push({
      pairing: Object.freeze([group.pairing[0], group.pairing[1]]) as readonly [string, string],
      seed: group.seed,
      // Integer division. Never `>> 1`: a shift coerces through ToInt32 and is
      // wrong for large values, and this project bans it for that reason.
      side0ScoreBasisPoints: Math.floor((first[0] + second[0]) / 2),
    });
  }

  // Sorted, so the resampling stream sees the same order on every machine and
  // the committed interval reproduces exactly (AD-5).
  pairs.sort(
    (left, right) =>
      left.pairing[0].localeCompare(right.pairing[0]) ||
      left.pairing[1].localeCompare(right.pairing[1]) ||
      left.seed - right.seed,
  );

  return { pairs, unpaired };
}

/**
 * Measure the side advantage a corpus of Matches exhibits.
 *
 * Throws when there is no mirrored pair to measure. A summary reporting
 * "no side advantage" from zero pairs is the single most misleading thing this
 * module could return, and AC4 asks for the advantage to be *measurable* --
 * an unmeasurable corpus must say so rather than report neutrality.
 */
export function summariseSideAdvantage(params: SideAdvantageParams): SideAdvantageSummary {
  const { matches, resamples, seed, confidenceBasisPoints } = params;

  const { pairs, unpaired } = collectPairs(matches);
  if (pairs.length === 0) {
    throw new Error(
      'summariseSideAdvantage: no complete mirrored pair in the corpus -- a side advantage cannot be measured from one-sided results',
    );
  }

  const scores = pairs.map((pair) => pair.side0ScoreBasisPoints);
  const interval = bootstrapMeanInterval({
    scoresBasisPoints: scores,
    resamples,
    seed,
    confidenceBasisPoints,
  });
  const observed = meanBasisPoints(scores);

  return Object.freeze({
    matches: matches.length,
    mirroredPairs: pairs.length,
    unpairedMatches: unpaired,
    pairs: Object.freeze(pairs) as readonly MirroredPair[],
    side0ScoreBasisPoints: observed,
    advantageBasisPoints: observed - NEUTRAL_SIDE_SCORE_BASIS_POINTS,
    interval,
    detected:
      interval.lowerBasisPoints > NEUTRAL_SIDE_SCORE_BASIS_POINTS ||
      interval.upperBasisPoints < NEUTRAL_SIDE_SCORE_BASIS_POINTS,
  });
}
