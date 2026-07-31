/**
 * The skill-separation gate (Story 2.4, FR-3).
 *
 * The project's highest-risk assumption stated as a computation: a stronger
 * player beats a weaker one often enough that a leaderboard built on this
 * environment measures skill rather than noise. Everything downstream -- every
 * Deployment, every rating, every published claim -- is worthless if this does
 * not hold, which is why it is a gate and not a report.
 *
 * Deliberately environment-agnostic. It is handed per-Match scores and knows
 * nothing about fighters, so `packages/env-fighter` supplies the ladder
 * (AD-1: the dependency runs adapter -> core, never the reverse) and the
 * *same* function can be fed synthetic results to prove it fails when it
 * should. A gate that has never been observed to fail is not known to be a
 * gate.
 *
 * Thresholds are integer basis points and are inputs, not policy baked in
 * here: the fighter ladder's three numbers were committed up front in
 * `docs/stories/2.4-skill-separation-gate.md` precisely so they could not be
 * moved to fit results, and they live next to the ladder that uses them.
 */

import {
  BASIS_POINTS_SCALE,
  WIN_BASIS_POINTS,
  bootstrapMeanInterval,
  meanBasisPoints,
  type BootstrapInterval,
} from './statistics';

/** One pairing's Matches, scored from the *stronger* Agent's point of view. */
export interface PairingSample {
  readonly stronger: string;
  readonly weaker: string;
  /** The lower confidence bound this pairing must clear, in basis points. */
  readonly thresholdBasisPoints: number;
  /** One entry per Match: 10000 stronger won, 5000 draw, 0 weaker won. */
  readonly scoresBasisPoints: readonly number[];
}

export interface PairingVerdict {
  readonly stronger: string;
  readonly weaker: string;
  readonly matches: number;
  readonly thresholdBasisPoints: number;
  readonly interval: BootstrapInterval;
  readonly meetsThreshold: boolean;
}

/** One Agent's record across every pairing it appeared in, either side. */
export interface LadderRow {
  readonly agent: string;
  readonly matches: number;
  readonly interval: BootstrapInterval;
}

export interface SkillGateVerdict {
  readonly passed: boolean;
  /** Every reason the gate failed, in a form a CI log can be read from. */
  readonly failures: readonly string[];
  readonly pairings: readonly PairingVerdict[];
  /** Descending by observed win rate. */
  readonly ladder: readonly LadderRow[];
  readonly minimumMatchesPerPairing: number;
}

export interface SkillGateParams {
  readonly pairings: readonly PairingSample[];
  readonly resamples: number;
  readonly seed: number;
  readonly confidenceBasisPoints?: number;
  /** Defaults to 200: 100 seeds played from both sides (AD-12). */
  readonly minimumMatchesPerPairing?: number;
}

export const DEFAULT_MINIMUM_MATCHES_PER_PAIRING = 200;

/**
 * The bootstrap seed for row `index`.
 *
 * Each pairing and each ladder row gets its own stream: reusing one seed
 * across rows would resample every sample along the identical index sequence,
 * which correlates the intervals and makes a "non-overlapping" comparison
 * between two of them mean less than it appears to. Derived from the caller's
 * one seed so the whole gate still reproduces from a single number (AD-5).
 */
function seedFor(seed: number, index: number): number {
  return (Math.imul(seed, 31) + index) | 0;
}

function assertPairings(pairings: readonly PairingSample[]): void {
  if (pairings.length === 0) {
    throw new Error('evaluateSkillGate: no pairings supplied -- a gate over nothing always passes');
  }
  for (const pairing of pairings) {
    if (pairing.stronger === pairing.weaker) {
      throw new Error(
        `evaluateSkillGate: pairing "${pairing.stronger}" is against itself, which has no stronger side`,
      );
    }
    if (
      !Number.isSafeInteger(pairing.thresholdBasisPoints) ||
      pairing.thresholdBasisPoints < 0 ||
      pairing.thresholdBasisPoints > BASIS_POINTS_SCALE
    ) {
      throw new Error(
        `evaluateSkillGate: threshold for ${pairing.stronger} over ${pairing.weaker} must be 0..${BASIS_POINTS_SCALE} basis points, received: ${String(pairing.thresholdBasisPoints)}`,
      );
    }
  }
}

/** Every Agent's scores, with the weaker side's Matches mirrored into its own row. */
function ladderScores(pairings: readonly PairingSample[]): Map<string, number[]> {
  const byAgent = new Map<string, number[]>();
  const append = (agent: string, scores: readonly number[]): void => {
    const existing = byAgent.get(agent);
    if (existing === undefined) {
      byAgent.set(agent, [...scores]);
      return;
    }
    existing.push(...scores);
  };

  for (const pairing of pairings) {
    append(pairing.stronger, pairing.scoresBasisPoints);
    // A Match is zero-sum in basis points, so the weaker side's score is the
    // complement. Recomputing it from the outcome would be a second source of
    // truth that could disagree with the first.
    append(
      pairing.weaker,
      pairing.scoresBasisPoints.map((score) => WIN_BASIS_POINTS - score),
    );
  }

  return byAgent;
}

/**
 * Run the gate. Never throws on a *failing* gate -- a failure is a result,
 * reported in `failures` with `passed: false`, so the caller can print all of
 * them at once rather than discovering them one exception at a time.
 */
export function evaluateSkillGate(params: SkillGateParams): SkillGateVerdict {
  const { pairings, resamples, seed } = params;
  const confidenceBasisPoints = params.confidenceBasisPoints;
  const minimumMatchesPerPairing =
    params.minimumMatchesPerPairing ?? DEFAULT_MINIMUM_MATCHES_PER_PAIRING;

  assertPairings(pairings);

  const failures: string[] = [];

  const pairingVerdicts: PairingVerdict[] = pairings.map((pairing, index) => {
    const interval = bootstrapMeanInterval({
      scoresBasisPoints: pairing.scoresBasisPoints,
      resamples,
      seed: seedFor(seed, index),
      confidenceBasisPoints,
    });
    const matches = pairing.scoresBasisPoints.length;
    const meetsThreshold = interval.lowerBasisPoints >= pairing.thresholdBasisPoints;

    if (matches < minimumMatchesPerPairing) {
      failures.push(
        `${pairing.stronger} vs ${pairing.weaker}: ${matches} Matches, fewer than the required ${minimumMatchesPerPairing}`,
      );
    }
    if (!meetsThreshold) {
      failures.push(
        `${pairing.stronger} over ${pairing.weaker}: 95% CI lower bound ${interval.lowerBasisPoints} bp is below the committed threshold ${pairing.thresholdBasisPoints} bp`,
      );
    }

    return {
      stronger: pairing.stronger,
      weaker: pairing.weaker,
      matches,
      thresholdBasisPoints: pairing.thresholdBasisPoints,
      interval,
      meetsThreshold,
    };
  });

  // The ladder half of AC1: three win rates, strictly ordered, with intervals
  // that do not overlap. A pairing threshold alone would pass a ladder whose
  // middle Agent is indistinguishable from the bottom one.
  const scoresByAgent = ladderScores(pairings);
  const ladder: LadderRow[] = [...scoresByAgent.entries()]
    .map(([agent, scores]) => ({ agent, scores, mean: meanBasisPoints(scores) }))
    // Ties broken by name so the row order -- and therefore each row's
    // bootstrap seed -- is a function of the input, never of Map insertion
    // order or of a sort that is not stable across engines.
    .sort((left, right) => right.mean - left.mean || left.agent.localeCompare(right.agent))
    .map((row, index) => ({
      agent: row.agent,
      matches: row.scores.length,
      interval: bootstrapMeanInterval({
        scoresBasisPoints: row.scores,
        resamples,
        seed: seedFor(seed, pairings.length + index),
        confidenceBasisPoints,
      }),
    }));

  for (let index = 1; index < ladder.length; index += 1) {
    const above = ladder[index - 1];
    const below = ladder[index];

    if (above.interval.pointEstimateBasisPoints <= below.interval.pointEstimateBasisPoints) {
      failures.push(
        `ladder is not strictly ordered: ${above.agent} (${above.interval.pointEstimateBasisPoints} bp) does not beat ${below.agent} (${below.interval.pointEstimateBasisPoints} bp)`,
      );
    }
    if (above.interval.lowerBasisPoints <= below.interval.upperBasisPoints) {
      failures.push(
        `confidence intervals overlap: ${above.agent} lower bound ${above.interval.lowerBasisPoints} bp is not above ${below.agent} upper bound ${below.interval.upperBasisPoints} bp`,
      );
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    pairings: pairingVerdicts,
    ladder,
    minimumMatchesPerPairing,
  };
}
