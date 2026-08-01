import { describe, expect, it } from 'vitest';
import {
  MINIMUM_MATCHES_PER_PAIRING,
  MINIMUM_MIRRORED_SEEDS_PER_PAIRING,
  isPairingRatable,
  summarisePairingCoverage,
  type CoverageMatch,
} from './pairing-coverage';

/**
 * Story 7.1 AC3 -- "a pairing with fewer than 30 Matches (15 seeds x 2 sides)
 * is shown as provisional and not rated".
 */

/** `seeds` seeds of one pairing, each played from both sides. */
function mirrored(a: string, b: string, seeds: number, seedBase = 1000): CoverageMatch[] {
  const matches: CoverageMatch[] = [];
  for (let offset = 0; offset < seeds; offset += 1) {
    matches.push({ seed: seedBase + offset, agentIds: [a, b] });
    matches.push({ seed: seedBase + offset, agentIds: [b, a] });
  }
  return matches;
}

/** `count` Matches of one pairing, every one with `a` on side 0. */
function oneSided(a: string, b: string, count: number, seedBase = 1000): CoverageMatch[] {
  const matches: CoverageMatch[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    matches.push({ seed: seedBase + offset, agentIds: [a, b] });
  }
  return matches;
}

function only(matches: readonly CoverageMatch[]) {
  const rows = summarisePairingCoverage(matches);
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('the committed floor', () => {
  it('is 30 Matches, being 15 seeds from both sides', () => {
    expect(MINIMUM_MATCHES_PER_PAIRING).toBe(30);
    expect(MINIMUM_MIRRORED_SEEDS_PER_PAIRING).toBe(15);
    expect(MINIMUM_MIRRORED_SEEDS_PER_PAIRING * 2).toBe(MINIMUM_MATCHES_PER_PAIRING);
  });
});

describe('provisional below the floor (AC3)', () => {
  it('rates a pairing at exactly 15 mirrored seeds', () => {
    const row = only(mirrored('a', 'b', 15));
    expect(row.matches).toBe(30);
    expect(row.mirroredSeeds).toBe(15);
    expect(row.provisional).toBe(false);
    expect(row.exclusions).toStrictEqual([]);
    expect(row.reason).toBeNull();
    expect(isPairingRatable(row)).toBe(true);
  });

  it('holds a pairing at 14 mirrored seeds provisional -- one seed short is short', () => {
    const row = only(mirrored('a', 'b', 14));
    expect(row.matches).toBe(28);
    expect(row.provisional).toBe(true);
    expect(row.exclusions).toStrictEqual(['insufficient-matches', 'insufficient-mirrored-seeds']);
    expect(row.reason).toContain('28 Matches');
    expect(isPairingRatable(row)).toBe(false);
  });

  it('holds an empty-of-that-pairing corpus to no row at all rather than a false pass', () => {
    expect(summarisePairingCoverage([])).toStrictEqual([]);
  });
});

describe('the count alone is not the rule (AC3, AD-12)', () => {
  it('holds 40 one-sided Matches provisional despite clearing the count', () => {
    // The failure this story exists to prevent: plenty of Matches, every one
    // with the same Agent on side 0, so a side advantage in the Environment is
    // still indistinguishable from a skill difference.
    const row = only(oneSided('a', 'b', 40));
    expect(row.matches).toBe(40);
    expect(row.mirroredSeeds).toBe(0);
    expect(row.matchesBySide).toStrictEqual([40, 0]);
    expect(row.provisional).toBe(true);
    expect(row.exclusions).toStrictEqual(['insufficient-mirrored-seeds']);
    expect(row.reason).toContain('0 seeds played from both sides');
  });

  it('holds 30 Matches split across 30 different seeds, none mirrored, provisional', () => {
    const row = only([...oneSided('a', 'b', 15, 1000), ...oneSided('b', 'a', 15, 2000)]);
    expect(row.matches).toBe(30);
    expect(row.matchesBySide).toStrictEqual([15, 15]);
    expect(row.mirroredSeeds).toBe(0);
    expect(row.provisional).toBe(true);
    expect(row.exclusions).toStrictEqual(['insufficient-mirrored-seeds']);
  });

  it('reports both reasons when both fail, and only the failing one when one does', () => {
    expect(only(mirrored('a', 'b', 2)).exclusions).toStrictEqual([
      'insufficient-matches',
      'insufficient-mirrored-seeds',
    ]);
    expect(only(oneSided('a', 'b', 40)).exclusions).toStrictEqual(['insufficient-mirrored-seeds']);
  });
});

describe('a pairing is one row, whichever way round it was played (D3)', () => {
  it('folds both orientations into a single row', () => {
    const rows = summarisePairingCoverage([
      { seed: 1, agentIds: ['b', 'a'] },
      { seed: 1, agentIds: ['a', 'b'] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].pairing).toStrictEqual(['a', 'b']);
    expect(rows[0].matches).toBe(2);
    expect(rows[0].mirroredSeeds).toBe(1);
  });

  it('keys sides by the sorted pairing, not by argument order', () => {
    // Both Matches have `b` on side 0; `a` sorts first, so side counts are [0, 2].
    const row = only([
      { seed: 1, agentIds: ['b', 'a'] },
      { seed: 2, agentIds: ['b', 'a'] },
    ]);
    expect(row.matchesBySide).toStrictEqual([0, 2]);
  });

  it('separates genuinely different pairings and sorts the rows', () => {
    const rows = summarisePairingCoverage([
      ...mirrored('z', 'y', 1),
      ...mirrored('a', 'b', 1),
      ...mirrored('a', 'c', 1),
    ]);
    expect(rows.map((row) => row.pairing)).toStrictEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['y', 'z'],
    ]);
  });

  it('produces the identical summary when the Matches are supplied in a different order', () => {
    const matches = [...mirrored('a', 'b', 3), ...mirrored('a', 'c', 3)];
    expect(summarisePairingCoverage([...matches].reverse())).toStrictEqual(
      summarisePairingCoverage(matches),
    );
  });
});

describe('degenerate input is rejected rather than silently absorbed', () => {
  it('refuses a pairing of an Agent with itself, which has no sides to compare', () => {
    expect(() => summarisePairingCoverage([{ seed: 1, agentIds: ['a', 'a'] }])).toThrow(
      /pairs "a" with itself/,
    );
  });

  it('refuses a non-integer seed', () => {
    expect(() =>
      summarisePairingCoverage([{ seed: Number.NaN, agentIds: ['a', 'b'] }]),
    ).toThrow(/non-integer seed/);
  });

  it('counts a duplicated orientation as the two Matches it is', () => {
    const row = only([
      { seed: 1, agentIds: ['a', 'b'] },
      { seed: 1, agentIds: ['a', 'b'] },
    ]);
    expect(row.matches).toBe(2);
    expect(row.mirroredSeeds).toBe(0);
    expect(row.seeds).toBe(1);
  });
});

describe('the returned rows are frozen', () => {
  it('cannot be mutated by a consumer', () => {
    const row = only(mirrored('a', 'b', 15));
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.exclusions)).toBe(true);
    expect(Object.isFrozen(row.pairing)).toBe(true);
  });
});
