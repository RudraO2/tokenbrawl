import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_SIDE_SCORE_BASIS_POINTS,
  side0Score,
  summariseSideAdvantage,
  type SideAdvantageMatch,
} from './side-advantage';
import { DRAW_BASIS_POINTS, LOSS_BASIS_POINTS, WIN_BASIS_POINTS } from './statistics';

/**
 * Story 7.1 AC4 -- "any side advantage in the Environment is measurable from
 * the published results and reported".
 *
 * Every case below is synthetic on purpose: a gate that has only ever been fed
 * the real corpus has never been observed to fire. The biased fixtures prove
 * detection works; the neutral ones prove it does not fire on noise.
 */

const RESAMPLES = 2000;
const SEED = 20260801;

function summarise(matches: readonly SideAdvantageMatch[]) {
  return summariseSideAdvantage({ matches, resamples: RESAMPLES, seed: SEED });
}

/**
 * `seeds` mirrored pairs of one pairing.
 *
 * `side0Wins` decides the outcome *by side*, not by Agent -- which is exactly
 * how a biased Environment behaves and what the estimator must catch.
 */
function biasedTowardSide0(seeds: number, pairing: readonly [string, string] = ['a', 'b']) {
  const matches: SideAdvantageMatch[] = [];
  for (let offset = 0; offset < seeds; offset += 1) {
    matches.push({
      seed: 1000 + offset,
      agentIds: [pairing[0], pairing[1]],
      side0ScoreBasisPoints: WIN_BASIS_POINTS,
    });
    matches.push({
      seed: 1000 + offset,
      agentIds: [pairing[1], pairing[0]],
      side0ScoreBasisPoints: WIN_BASIS_POINTS,
    });
  }
  return matches;
}

/** The opposite fixture: whichever Agent sits on side 1 wins, every time. */
function biasedTowardSide1(seeds: number) {
  return biasedTowardSide0(seeds).map((match) => ({
    ...match,
    side0ScoreBasisPoints: LOSS_BASIS_POINTS,
  }));
}

/**
 * A neutral Environment with a real skill difference: `a` beats `b` from
 * either side. Every pair therefore scores 5000 and the estimator must report
 * no side advantage despite a lopsided win rate.
 */
function skillDifferenceOnly(seeds: number, seedBase = 1000) {
  const matches: SideAdvantageMatch[] = [];
  for (let offset = 0; offset < seeds; offset += 1) {
    matches.push({
      seed: seedBase + offset,
      agentIds: ['a', 'b'],
      side0ScoreBasisPoints: WIN_BASIS_POINTS,
    });
    matches.push({
      seed: seedBase + offset,
      agentIds: ['b', 'a'],
      side0ScoreBasisPoints: LOSS_BASIS_POINTS,
    });
  }
  return matches;
}

describe('a side advantage is detected when one exists (AC4)', () => {
  it('reports the full 5000 bp when side 0 always wins', () => {
    const summary = summarise(biasedTowardSide0(50));
    expect(summary.mirroredPairs).toBe(50);
    expect(summary.side0ScoreBasisPoints).toBe(WIN_BASIS_POINTS);
    expect(summary.advantageBasisPoints).toBe(5000);
    expect(summary.detected).toBe(true);
    expect(summary.interval.lowerBasisPoints).toBeGreaterThan(NEUTRAL_SIDE_SCORE_BASIS_POINTS);
  });

  it('reports a signed -5000 bp when side 1 always wins', () => {
    const summary = summarise(biasedTowardSide1(50));
    expect(summary.side0ScoreBasisPoints).toBe(LOSS_BASIS_POINTS);
    expect(summary.advantageBasisPoints).toBe(-5000);
    expect(summary.detected).toBe(true);
    expect(summary.interval.upperBasisPoints).toBeLessThan(NEUTRAL_SIDE_SCORE_BASIS_POINTS);
  });

  it('detects a modest bias: side 0 wins 3 pairs in every 4', () => {
    const matches: SideAdvantageMatch[] = [];
    for (let offset = 0; offset < 200; offset += 1) {
      const side0Wins = offset % 4 !== 0;
      const score = side0Wins ? WIN_BASIS_POINTS : LOSS_BASIS_POINTS;
      matches.push({ seed: 1000 + offset, agentIds: ['a', 'b'], side0ScoreBasisPoints: score });
      matches.push({ seed: 1000 + offset, agentIds: ['b', 'a'], side0ScoreBasisPoints: score });
    }
    const summary = summarise(matches);
    expect(summary.side0ScoreBasisPoints).toBe(7500);
    expect(summary.advantageBasisPoints).toBe(2500);
    expect(summary.detected).toBe(true);
  });
});

describe('no side advantage is reported when there is none (AC4)', () => {
  it('scores every pair at exactly neutral when only skill separates the Agents', () => {
    const summary = summarise(skillDifferenceOnly(50));
    expect(summary.pairs.every((pair) => pair.side0ScoreBasisPoints === DRAW_BASIS_POINTS)).toBe(
      true,
    );
    expect(summary.advantageBasisPoints).toBe(0);
    expect(summary.detected).toBe(false);
    expect(summary.interval.lowerBasisPoints).toBe(DRAW_BASIS_POINTS);
    expect(summary.interval.upperBasisPoints).toBe(DRAW_BASIS_POINTS);
  });

  it('does not fire on a balanced-but-noisy corpus', () => {
    // Alternating pairs: side 0 sweeps one seed, side 1 sweeps the next. Every
    // Match is decisive, so the estimator sees real variance rather than draws.
    const matches: SideAdvantageMatch[] = [];
    for (let offset = 0; offset < 200; offset += 1) {
      const score = offset % 2 === 0 ? WIN_BASIS_POINTS : LOSS_BASIS_POINTS;
      matches.push({ seed: 1000 + offset, agentIds: ['a', 'b'], side0ScoreBasisPoints: score });
      matches.push({ seed: 1000 + offset, agentIds: ['b', 'a'], side0ScoreBasisPoints: score });
    }
    const summary = summarise(matches);
    expect(summary.advantageBasisPoints).toBe(0);
    expect(summary.detected).toBe(false);
    expect(summary.interval.lowerBasisPoints).toBeLessThanOrEqual(DRAW_BASIS_POINTS);
    expect(summary.interval.upperBasisPoints).toBeGreaterThanOrEqual(DRAW_BASIS_POINTS);
  });

  it('scores a pair of draws as neutral', () => {
    const summary = summarise([
      { seed: 1, agentIds: ['a', 'b'], side0ScoreBasisPoints: DRAW_BASIS_POINTS },
      { seed: 1, agentIds: ['b', 'a'], side0ScoreBasisPoints: DRAW_BASIS_POINTS },
      { seed: 2, agentIds: ['a', 'b'], side0ScoreBasisPoints: DRAW_BASIS_POINTS },
      { seed: 2, agentIds: ['b', 'a'], side0ScoreBasisPoints: DRAW_BASIS_POINTS },
    ]);
    expect(summary.advantageBasisPoints).toBe(0);
    expect(summary.detected).toBe(false);
  });
});

describe('only complete mirrored pairs are measured', () => {
  it('excludes a Match whose mirror was never played, and says how many', () => {
    const summary = summarise([
      ...biasedTowardSide0(2),
      { seed: 9999, agentIds: ['a', 'b'], side0ScoreBasisPoints: WIN_BASIS_POINTS },
    ]);
    expect(summary.matches).toBe(5);
    expect(summary.mirroredPairs).toBe(2);
    expect(summary.unpairedMatches).toBe(1);
  });

  it('treats two Matches of the same orientation as unpaired, not as a pair', () => {
    // The failure mode that matters: a one-sided group must never be folded
    // into an estimator whose premise is that skill cancels.
    const summary = summarise([
      ...biasedTowardSide0(1),
      { seed: 5, agentIds: ['a', 'b'], side0ScoreBasisPoints: WIN_BASIS_POINTS },
      { seed: 5, agentIds: ['a', 'b'], side0ScoreBasisPoints: WIN_BASIS_POINTS },
    ]);
    expect(summary.mirroredPairs).toBe(1);
    expect(summary.unpairedMatches).toBe(2);
  });

  it('treats a surplus third Match of a pair as unpaired rather than pairing it arbitrarily', () => {
    const summary = summarise([
      ...biasedTowardSide0(2),
      { seed: 1000, agentIds: ['a', 'b'], side0ScoreBasisPoints: LOSS_BASIS_POINTS },
    ]);
    // Seed 1000 now has two of one orientation and one of the other: the whole
    // group is unpaired, leaving only seed 1001.
    expect(summary.mirroredPairs).toBe(1);
    expect(summary.unpairedMatches).toBe(3);
  });

  it('pairs across different pairings independently', () => {
    const summary = summarise([...biasedTowardSide0(3), ...biasedTowardSide0(3, ['c', 'd'])]);
    expect(summary.mirroredPairs).toBe(6);
    expect(summary.unpairedMatches).toBe(0);
  });

  it('matches a mirror regardless of which orientation was supplied first', () => {
    const summary = summarise([
      { seed: 1, agentIds: ['b', 'a'], side0ScoreBasisPoints: LOSS_BASIS_POINTS },
      { seed: 1, agentIds: ['a', 'b'], side0ScoreBasisPoints: WIN_BASIS_POINTS },
    ]);
    expect(summary.mirroredPairs).toBe(1);
    // `a` won from side 0 and lost from side 1: pure skill, no side advantage.
    expect(summary.pairs[0].side0ScoreBasisPoints).toBe(DRAW_BASIS_POINTS);
  });
});

describe('the summary reproduces exactly (AD-5, INV-2)', () => {
  it('is identical when the same corpus is supplied in a different order', () => {
    // Disjoint seed ranges: overlapping them would put four Matches in one
    // (pairing, seed) group, which is correctly measured as unpaired.
    const matches = [...biasedTowardSide0(20), ...skillDifferenceOnly(20, 5000)];
    expect(summarise([...matches].reverse())).toStrictEqual(summarise(matches));
  });

  it('is identical across two calls with the same resampling seed', () => {
    const matches = biasedTowardSide0(20);
    expect(summarise(matches).interval).toStrictEqual(summarise(matches).interval);
  });
});

describe('an unmeasurable corpus says so rather than reporting neutrality', () => {
  it('throws on an empty corpus', () => {
    expect(() => summarise([])).toThrow(/no complete mirrored pair/);
  });

  it('throws on a corpus with no mirror anywhere', () => {
    expect(() =>
      summarise([
        { seed: 1, agentIds: ['a', 'b'], side0ScoreBasisPoints: WIN_BASIS_POINTS },
        { seed: 2, agentIds: ['a', 'b'], side0ScoreBasisPoints: WIN_BASIS_POINTS },
      ]),
    ).toThrow(/no complete mirrored pair/);
  });
});

describe('degenerate input is rejected', () => {
  it('refuses an Agent paired with itself', () => {
    expect(() =>
      summarise([{ seed: 1, agentIds: ['a', 'a'], side0ScoreBasisPoints: DRAW_BASIS_POINTS }]),
    ).toThrow(/pairs "a" with itself/);
  });

  it('refuses a non-integer seed', () => {
    expect(() =>
      summarise([
        { seed: 1.5, agentIds: ['a', 'b'], side0ScoreBasisPoints: DRAW_BASIS_POINTS },
      ]),
    ).toThrow(/non-integer seed/);
  });

  it('refuses a score outside the basis-point range', () => {
    expect(() =>
      summarise([{ seed: 1, agentIds: ['a', 'b'], side0ScoreBasisPoints: 10001 }]),
    ).toThrow(/outside 0\.\.10000 basis points/);
    expect(() =>
      summarise([{ seed: 1, agentIds: ['a', 'b'], side0ScoreBasisPoints: -1 }]),
    ).toThrow(/outside 0\.\.10000 basis points/);
  });
});

describe('side0Score', () => {
  it('maps a terminal outcome to side 0’s score', () => {
    expect(side0Score('p1')).toBe(WIN_BASIS_POINTS);
    expect(side0Score('p2')).toBe(LOSS_BASIS_POINTS);
    expect(side0Score('draw')).toBe(DRAW_BASIS_POINTS);
  });

  it('agrees with the neutral constant', () => {
    expect(NEUTRAL_SIDE_SCORE_BASIS_POINTS).toBe(DRAW_BASIS_POINTS);
    expect(NEUTRAL_SIDE_SCORE_BASIS_POINTS).toBe(5000);
  });
});
