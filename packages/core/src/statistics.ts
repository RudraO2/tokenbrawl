/**
 * Seeded percentile bootstrap over Match outcomes (AD-5).
 *
 * Everything here is integer basis points -- 10000 = 1.0000 -- rather than a
 * ratio in [0,1]. Two reasons, and both are load-bearing:
 *
 *   - `scripts/audit-invariants.sh` bans a floating-point literal anywhere in
 *     `packages/core`, because a float that reaches simulation state is
 *     unhashable by the canonical hasher (INV-2). A win-rate threshold written
 *     `0.65` would trip that sweep; `6500` says the same thing and cannot.
 *   - A bootstrap is a resampling procedure whose whole value is that it
 *     reproduces exactly. Accumulating 2,000 resamples of 200 float means is
 *     order-dependent at the last bit; summing integers is not. The confidence
 *     interval a gate is judged against must be the same interval on every
 *     machine that runs it, not merely a close one.
 *
 * No wall clock, no `Math.random`: the generator is seeded by the caller and
 * threaded through the loop, exactly as the Match PRNG is (INV-1, INV-2).
 */

/** One Match scored from one Agent's point of view. */
export const WIN_BASIS_POINTS = 10000;
export const DRAW_BASIS_POINTS = 5000;
export const LOSS_BASIS_POINTS = 0;

/** 10000 basis points = 1.0000. */
export const BASIS_POINTS_SCALE = 10000;

/**
 * xorshift32, copied rather than imported.
 *
 * `packages/env-fighter/src/prng.ts` holds an identical pair, and AD-1 forbids
 * `packages/core` importing an Environment Adapter -- the dependency runs one
 * way only, and ESLint enforces it. Duplicating eight lines is the cheaper of
 * the two available wrongs; the alternative is a shared package that exists to
 * hold one function.
 */
const SEED_MULTIPLIER = 0x9e3779b9;
const NON_ZERO_FALLBACK = 0x6d2b79f5;

function mixSeed(seed: number): number {
  const mixed = Math.imul(seed | 0, SEED_MULTIPLIER) | 0;
  return mixed === 0 ? NON_ZERO_FALLBACK : mixed;
}

function nextRngState(state: number): number {
  let x = state | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x | 0;
}

export interface BootstrapInterval {
  /** Number of Matches the interval was computed from. */
  readonly sampleSize: number;
  /** The observed mean score, in basis points. */
  readonly pointEstimateBasisPoints: number;
  readonly lowerBasisPoints: number;
  readonly upperBasisPoints: number;
  readonly resamples: number;
  /** e.g. 9500 for a 95% interval. */
  readonly confidenceBasisPoints: number;
  /** The seed the resampling used, so the interval can be reproduced. */
  readonly seed: number;
}

export interface BootstrapParams {
  /** One entry per Match, each in [0, 10000]. */
  readonly scoresBasisPoints: readonly number[];
  readonly resamples: number;
  readonly seed: number;
  /** Defaults to a 95% interval. */
  readonly confidenceBasisPoints?: number;
}

const DEFAULT_CONFIDENCE_BASIS_POINTS = 9500;

/**
 * Mean of a score sample, floored to an integer basis point.
 *
 * Flooring rather than rounding, consistently everywhere: a win rate reported
 * to a gate must never round *up* across a threshold it did not actually meet.
 */
export function meanBasisPoints(scoresBasisPoints: readonly number[]): number {
  if (scoresBasisPoints.length === 0) {
    throw new Error('meanBasisPoints: an empty sample has no mean');
  }
  let total = 0;
  for (const score of scoresBasisPoints) {
    total += score;
  }
  return Math.floor(total / scoresBasisPoints.length);
}

function assertSample(scoresBasisPoints: readonly number[]): void {
  if (scoresBasisPoints.length === 0) {
    throw new Error('bootstrapMeanInterval: an empty sample has no interval');
  }
  for (const score of scoresBasisPoints) {
    if (!Number.isSafeInteger(score)) {
      throw new Error(
        `bootstrapMeanInterval: score must be a safe integer basis point, received: ${String(score)}`,
      );
    }
    if (score < LOSS_BASIS_POINTS || score > WIN_BASIS_POINTS) {
      throw new Error(
        `bootstrapMeanInterval: score ${score} is outside 0..${WIN_BASIS_POINTS} basis points`,
      );
    }
  }
}

/**
 * Percentile bootstrap: resample the observed Matches with replacement,
 * `resamples` times, and read the confidence interval off the sorted
 * distribution of resampled means.
 *
 * Deliberately the percentile method and not a normal approximation. A win
 * rate near 0 or 1 -- which is exactly where a skill gate lives -- has a
 * skewed sampling distribution, and a symmetric +/- interval around it
 * reports bounds outside [0,1] and a lower bound that is simply wrong in the
 * direction that matters.
 */
export function bootstrapMeanInterval(params: BootstrapParams): BootstrapInterval {
  const { scoresBasisPoints, resamples, seed } = params;
  const confidenceBasisPoints = params.confidenceBasisPoints ?? DEFAULT_CONFIDENCE_BASIS_POINTS;

  assertSample(scoresBasisPoints);
  if (!Number.isSafeInteger(resamples) || resamples < 1) {
    throw new Error(`bootstrapMeanInterval: resamples must be a positive integer, received: ${String(resamples)}`);
  }
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`bootstrapMeanInterval: seed must be a safe integer, received: ${String(seed)}`);
  }
  if (
    !Number.isSafeInteger(confidenceBasisPoints) ||
    confidenceBasisPoints <= 0 ||
    confidenceBasisPoints >= BASIS_POINTS_SCALE
  ) {
    throw new Error(
      `bootstrapMeanInterval: confidenceBasisPoints must lie strictly between 0 and ${BASIS_POINTS_SCALE}, received: ${String(confidenceBasisPoints)}`,
    );
  }

  const sampleSize = scoresBasisPoints.length;
  const means: number[] = [];
  let rngState = mixSeed(seed);

  for (let resample = 0; resample < resamples; resample += 1) {
    let total = 0;
    for (let draw = 0; draw < sampleSize; draw += 1) {
      rngState = nextRngState(rngState);
      total += scoresBasisPoints[Math.abs(rngState) % sampleSize];
    }
    means.push(Math.floor(total / sampleSize));
  }

  means.sort((left, right) => left - right);

  // Two-sided: half the excluded mass sits in each tail. Integer division
  // throughout, so the index is a fact about the sorted array rather than a
  // rounded float that could land one element either side on some machines.
  const tailBasisPoints = Math.floor((BASIS_POINTS_SCALE - confidenceBasisPoints) / 2);
  const lowerIndex = Math.floor((resamples * tailBasisPoints) / BASIS_POINTS_SCALE);
  const upperIndex = resamples - 1 - lowerIndex;

  return {
    sampleSize,
    pointEstimateBasisPoints: meanBasisPoints(scoresBasisPoints),
    // `upperIndex` can fall below `lowerIndex` only when `resamples` is so
    // small that both tails swallow the sample; clamping keeps the interval
    // ordered rather than returning an inverted one nobody would notice.
    lowerBasisPoints: means[Math.min(lowerIndex, upperIndex)],
    upperBasisPoints: means[Math.max(lowerIndex, upperIndex)],
    resamples,
    confidenceBasisPoints,
    seed,
  };
}
