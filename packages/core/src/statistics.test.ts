import { describe, expect, it } from 'vitest';
import {
  BASIS_POINTS_SCALE,
  DRAW_BASIS_POINTS,
  LOSS_BASIS_POINTS,
  WIN_BASIS_POINTS,
  bootstrapMeanInterval,
  meanBasisPoints,
} from './statistics';

/**
 * The story's test plan: "a unit test of the bootstrap CI implementation
 * against a known distribution".
 *
 * A bootstrap has no closed form, so "known" here means a sample whose true
 * mean is exact by construction and whose interval can be reasoned about
 * analytically -- not a hard-coded number copied out of a previous run, which
 * would pin the implementation to itself.
 */

const SEED = 4242;
const RESAMPLES = 2000;

function sample(wins: number, losses: number, draws = 0): number[] {
  return [
    ...Array.from({ length: wins }, () => WIN_BASIS_POINTS),
    ...Array.from({ length: losses }, () => LOSS_BASIS_POINTS),
    ...Array.from({ length: draws }, () => DRAW_BASIS_POINTS),
  ];
}

describe('meanBasisPoints', () => {
  it('scores a draw as exactly half a win', () => {
    expect(meanBasisPoints(sample(0, 0, 4))).toBe(DRAW_BASIS_POINTS);
    expect(meanBasisPoints(sample(2, 2))).toBe(DRAW_BASIS_POINTS);
  });

  it('floors rather than rounds, so a rate never crosses a threshold it did not meet', () => {
    // 2 wins in 3 is 6666.67 bp. Rounding would report 6667 and clear a 6667
    // threshold this sample does not actually meet.
    expect(meanBasisPoints(sample(2, 1))).toBe(6666);
  });

  it('rejects an empty sample rather than reporting NaN', () => {
    expect(() => meanBasisPoints([])).toThrow(/empty sample/);
  });
});

describe('bootstrapMeanInterval (AD-5: seeded, or the gate does not reproduce)', () => {
  it('brackets the point estimate of a known distribution', () => {
    const interval = bootstrapMeanInterval({
      scoresBasisPoints: sample(150, 50),
      resamples: RESAMPLES,
      seed: SEED,
    });

    expect(interval.pointEstimateBasisPoints).toBe(7500);
    expect(interval.lowerBasisPoints).toBeLessThanOrEqual(7500);
    expect(interval.upperBasisPoints).toBeGreaterThanOrEqual(7500);
    expect(interval.sampleSize).toBe(200);
  });

  it('lands within one standard error of the analytic interval for a known Bernoulli sample', () => {
    // p = 0.75, n = 200: the standard error is sqrt(p(1-p)/n) = 0.0306, so a
    // 95% interval is 7500 +/- ~600 bp. The percentile bootstrap of a
    // Bernoulli sample is close to that by construction, which is the only
    // externally-checkable fact about a bootstrap. Tolerance is one standard
    // error, so this catches a genuinely wrong interval (a half-width that is
    // out by 2x, or tails read off the wrong end) without being a
    // reimplementation of the algorithm in the assertion.
    const interval = bootstrapMeanInterval({
      scoresBasisPoints: sample(150, 50),
      resamples: RESAMPLES,
      seed: SEED,
    });

    const analyticHalfWidth = 600;
    const tolerance = 306;
    const lowerHalfWidth = interval.pointEstimateBasisPoints - interval.lowerBasisPoints;
    const upperHalfWidth = interval.upperBasisPoints - interval.pointEstimateBasisPoints;

    expect(Math.abs(lowerHalfWidth - analyticHalfWidth)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(upperHalfWidth - analyticHalfWidth)).toBeLessThanOrEqual(tolerance);
  });

  it('collapses to a point interval when every Match had the same outcome', () => {
    // Resampling a constant sample can only ever produce that constant. An
    // implementation that added a spurious continuity correction or a normal
    // approximation would widen this and report an interval reaching below a
    // threshold a perfect record obviously clears.
    const interval = bootstrapMeanInterval({
      scoresBasisPoints: sample(200, 0),
      resamples: RESAMPLES,
      seed: SEED,
    });

    expect(interval.lowerBasisPoints).toBe(WIN_BASIS_POINTS);
    expect(interval.upperBasisPoints).toBe(WIN_BASIS_POINTS);
  });

  it('narrows as the sample grows', () => {
    const halfWidth = (wins: number, losses: number): number => {
      const interval = bootstrapMeanInterval({
        scoresBasisPoints: sample(wins, losses),
        resamples: RESAMPLES,
        seed: SEED,
      });
      return interval.upperBasisPoints - interval.lowerBasisPoints;
    };

    expect(halfWidth(600, 200)).toBeLessThan(halfWidth(15, 5));
  });

  it('reproduces exactly for the same seed and differs for another', () => {
    const scoresBasisPoints = sample(120, 80);
    const first = bootstrapMeanInterval({ scoresBasisPoints, resamples: RESAMPLES, seed: SEED });
    const again = bootstrapMeanInterval({ scoresBasisPoints, resamples: RESAMPLES, seed: SEED });
    const other = bootstrapMeanInterval({ scoresBasisPoints, resamples: RESAMPLES, seed: SEED + 1 });

    expect(again).toStrictEqual(first);
    // Not a determinism check -- this one proves the seed is actually threaded
    // into the resampling rather than ignored, which a "same seed, same
    // answer" assertion alone would pass against a constant.
    expect([other.lowerBasisPoints, other.upperBasisPoints]).not.toStrictEqual([
      first.lowerBasisPoints,
      first.upperBasisPoints,
    ]);
  });

  it('honours a wider confidence level with a wider interval', () => {
    const scoresBasisPoints = sample(150, 50);
    const ninetyFive = bootstrapMeanInterval({ scoresBasisPoints, resamples: RESAMPLES, seed: SEED });
    const ninetyNine = bootstrapMeanInterval({
      scoresBasisPoints,
      resamples: RESAMPLES,
      seed: SEED,
      confidenceBasisPoints: 9900,
    });

    expect(ninetyNine.lowerBasisPoints).toBeLessThanOrEqual(ninetyFive.lowerBasisPoints);
    expect(ninetyNine.upperBasisPoints).toBeGreaterThanOrEqual(ninetyFive.upperBasisPoints);
  });

  it('keeps the interval ordered even when the resample count is smaller than the tails', () => {
    const interval = bootstrapMeanInterval({
      scoresBasisPoints: sample(3, 1),
      resamples: 1,
      seed: SEED,
    });

    expect(interval.lowerBasisPoints).toBeLessThanOrEqual(interval.upperBasisPoints);
  });

  describe('rejects a degenerate configuration rather than reporting a meaningless interval', () => {
    const scoresBasisPoints = sample(10, 10);

    it('rejects an empty sample', () => {
      expect(() =>
        bootstrapMeanInterval({ scoresBasisPoints: [], resamples: RESAMPLES, seed: SEED }),
      ).toThrow(/empty sample/);
    });

    it('rejects a score outside the basis-point range', () => {
      expect(() =>
        bootstrapMeanInterval({
          scoresBasisPoints: [WIN_BASIS_POINTS + 1],
          resamples: RESAMPLES,
          seed: SEED,
        }),
      ).toThrow(/outside 0\.\.10000/);
      expect(() =>
        bootstrapMeanInterval({ scoresBasisPoints: [-1], resamples: RESAMPLES, seed: SEED }),
      ).toThrow(/outside 0\.\.10000/);
    });

    it('rejects a non-integer score, which is how a float would enter the gate', () => {
      expect(() =>
        bootstrapMeanInterval({
          scoresBasisPoints: [WIN_BASIS_POINTS / 3],
          resamples: RESAMPLES,
          seed: SEED,
        }),
      ).toThrow(/safe integer/);
    });

    it('rejects a non-positive resample count', () => {
      expect(() => bootstrapMeanInterval({ scoresBasisPoints, resamples: 0, seed: SEED })).toThrow(
        /positive integer/,
      );
    });

    it('rejects a confidence level of 0 or 100 percent', () => {
      expect(() =>
        bootstrapMeanInterval({
          scoresBasisPoints,
          resamples: RESAMPLES,
          seed: SEED,
          confidenceBasisPoints: BASIS_POINTS_SCALE,
        }),
      ).toThrow(/strictly between/);
      expect(() =>
        bootstrapMeanInterval({
          scoresBasisPoints,
          resamples: RESAMPLES,
          seed: SEED,
          confidenceBasisPoints: 0,
        }),
      ).toThrow(/strictly between/);
    });

    it('rejects a non-integer seed, which would not reproduce', () => {
      expect(() =>
        bootstrapMeanInterval({ scoresBasisPoints, resamples: RESAMPLES, seed: 1.5 }),
      ).toThrow(/safe integer/);
    });
  });
});
