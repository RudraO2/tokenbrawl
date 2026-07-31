import { describe, expect, it } from 'vitest';
import { evaluateSkillGate, type PairingSample } from './skill-gate';
import { DRAW_BASIS_POINTS, LOSS_BASIS_POINTS, WIN_BASIS_POINTS } from './statistics';

/**
 * The story's test plan: "a test that the gate correctly *fails* when fed
 * synthetic 50/50 results".
 *
 * A gate nobody has watched fail is not known to be a gate -- it is an
 * assertion that has only ever been run against data that satisfies it. Every
 * failure mode the gate is supposed to catch gets its own synthetic sample
 * here, with no environment and no bots involved.
 */

const SEED = 20260731;
const RESAMPLES = 2000;
const MATCHES = 200;

/**
 * A deterministic sample with exactly `wins` wins in `MATCHES` Matches.
 *
 * Interleaved by a fixed stride rather than blocked, so a resample that
 * happened to favour one contiguous half of the array cannot be mistaken for
 * a real effect.
 */
function scores(wins: number, matches = MATCHES, draws = 0): number[] {
  return Array.from({ length: matches }, (_unused, index) => {
    if (index < draws) {
      return DRAW_BASIS_POINTS;
    }
    return (index * wins) % matches < wins ? WIN_BASIS_POINTS : LOSS_BASIS_POINTS;
  });
}

function pairing(
  stronger: string,
  weaker: string,
  wins: number,
  thresholdBasisPoints: number,
  matches = MATCHES,
): PairingSample {
  return { stronger, weaker, thresholdBasisPoints, scoresBasisPoints: scores(wins, matches) };
}

/** A ladder that comfortably clears every one of the story's thresholds. */
function separatedLadder(): PairingSample[] {
  return [
    pairing('strong', 'weak', 198, 6500),
    pairing('strong', 'middle', 177, 5500),
    pairing('middle', 'weak', 171, 5000),
  ];
}

function evaluate(pairings: readonly PairingSample[]) {
  return evaluateSkillGate({ pairings, resamples: RESAMPLES, seed: SEED });
}

describe('evaluateSkillGate', () => {
  it('passes a genuinely separated ladder', () => {
    const verdict = evaluate(separatedLadder());

    expect(verdict.failures).toStrictEqual([]);
    expect(verdict.passed).toBe(true);
    expect(verdict.ladder.map((row) => row.agent)).toStrictEqual(['strong', 'middle', 'weak']);
  });

  it('FAILS synthetic 50/50 results (the story’s named negative case)', () => {
    // Three coin-flip pairings: no ordering exists, so every threshold and
    // every ladder comparison must fail at once.
    const verdict = evaluate([
      pairing('a', 'b', 100, 6500),
      pairing('a', 'c', 100, 5500),
      pairing('b', 'c', 100, 5000),
    ]);

    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join('\n')).toMatch(/CI lower bound/);
    expect(verdict.failures.some((failure) => /not strictly ordered/.test(failure))).toBe(true);
    expect(verdict.failures.some((failure) => /intervals overlap/.test(failure))).toBe(true);
  });

  it('fails a ladder whose Agents are exactly tied, not merely overlapping', () => {
    // "Strictly ordered" (AC1) has to reject a tie, and a tie is the one case
    // the interval check cannot stand in for -- found by mutation: relaxing
    // the ordering comparison from `<=` to `<` passed every other case in this
    // file, because no other sample produces two identical win rates.
    //
    // Every pairing here is an exact 50/50, so all three Agents sit at 5000 bp
    // and each adjacent pair in the ladder is tied rather than close.
    const verdict = evaluate([
      pairing('a', 'b', 100, 0),
      pairing('a', 'c', 100, 0),
      pairing('b', 'c', 100, 0),
    ]);

    expect(verdict.ladder.map((row) => row.interval.pointEstimateBasisPoints)).toStrictEqual([
      5000, 5000, 5000,
    ]);
    // One per adjacent pair: both ties are named, not just the first.
    expect(verdict.failures.filter((failure) => /not strictly ordered/.test(failure))).toHaveLength(2);
    expect(verdict.pairings.every((entry) => entry.meetsThreshold)).toBe(true);
    expect(verdict.passed).toBe(false);
  });

  it('fails a pairing whose point estimate clears the threshold but whose CI does not', () => {
    // 0.5600 observed against a 0.5500 threshold: the gate is a statement
    // about the lower bound, not the point estimate, and this is the case that
    // separates the two. A gate comparing point estimates would pass it.
    const verdict = evaluate([
      pairing('strong', 'weak', 198, 6500),
      pairing('strong', 'middle', 112, 5500),
      pairing('middle', 'weak', 171, 5000),
    ]);

    const marginal = verdict.pairings.find((entry) => entry.weaker === 'middle');
    expect(marginal?.interval.pointEstimateBasisPoints).toBeGreaterThan(5500);
    expect(marginal?.meetsThreshold).toBe(false);
    expect(verdict.passed).toBe(false);
  });

  it('fails a ladder that is ordered but whose intervals overlap', () => {
    // Ordered on the point estimates, indistinguishable statistically. This is
    // the failure AC1 exists for: a ranking that is real only to four decimal
    // places is noise wearing a leaderboard.
    const verdict = evaluate([
      pairing('strong', 'weak', 104, 0),
      pairing('strong', 'middle', 102, 0),
      pairing('middle', 'weak', 101, 0),
    ]);

    expect(verdict.pairings.every((entry) => entry.meetsThreshold)).toBe(true);
    expect(verdict.failures.some((failure) => /intervals overlap/.test(failure))).toBe(true);
    expect(verdict.passed).toBe(false);
  });

  it('fails a pairing that did not play enough Matches', () => {
    const verdict = evaluate([
      pairing('strong', 'weak', 99, 6500, 100), // 100 Matches, not the required 200
      pairing('strong', 'middle', 177, 5500),
      pairing('middle', 'weak', 171, 5000),
    ]);

    expect(verdict.failures.some((failure) => /fewer than the required 200/.test(failure))).toBe(true);
    expect(verdict.passed).toBe(false);
  });

  it('reports every failure at once rather than the first', () => {
    // Ten coin-flip Matches per pairing: too few Matches *and* a lower bound
    // nowhere near any threshold, on all three pairings at once.
    const verdict = evaluate([
      pairing('a', 'b', 5, 6500, 10),
      pairing('a', 'c', 5, 5500, 10),
      pairing('b', 'c', 5, 5000, 10),
    ]);

    expect(verdict.failures.filter((failure) => /fewer than the required/.test(failure))).toHaveLength(3);
    expect(verdict.failures.filter((failure) => /CI lower bound/.test(failure))).toHaveLength(3);
    expect(verdict.failures.length).toBeGreaterThan(6);
  });

  it('mirrors the weaker side’s Matches into its own ladder row', () => {
    // The ladder row for an Agent that only ever appears as the weaker side
    // must still exist and must be the complement, not an empty sample.
    const verdict = evaluate(separatedLadder());
    const weak = verdict.ladder.find((row) => row.agent === 'weak');
    const strong = verdict.ladder.find((row) => row.agent === 'strong');

    expect(weak?.matches).toBe(MATCHES * 2);
    expect(strong?.matches).toBe(MATCHES * 2);
    expect(weak?.interval.pointEstimateBasisPoints).toBeLessThan(
      strong?.interval.pointEstimateBasisPoints ?? 0,
    );
  });

  it('reproduces exactly for the same seed', () => {
    const pairings = separatedLadder();
    expect(evaluate(pairings)).toStrictEqual(evaluate(pairings));
  });

  it('gives each row its own resampling stream', () => {
    // One shared seed across rows would resample every sample along the same
    // index sequence, correlating the intervals a non-overlap check compares.
    const verdict = evaluate(separatedLadder());
    const seeds = [
      ...verdict.pairings.map((entry) => entry.interval.seed),
      ...verdict.ladder.map((row) => row.interval.seed),
    ];
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  describe('rejects a degenerate input rather than passing vacuously', () => {
    it('rejects an empty pairing list', () => {
      expect(() => evaluate([])).toThrow(/no pairings/);
    });

    it('rejects an Agent paired against itself', () => {
      expect(() => evaluate([pairing('a', 'a', 100, 5000)])).toThrow(/against itself/);
    });

    it('rejects a threshold outside the basis-point range', () => {
      expect(() => evaluate([pairing('a', 'b', 100, 10001)])).toThrow(/basis points/);
      expect(() => evaluate([pairing('a', 'b', 100, -1)])).toThrow(/basis points/);
    });
  });
});
