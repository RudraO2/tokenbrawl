import type { AgentIdentity } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import {
  computeLeaderboard,
  type LeaderboardMatch,
  type RatingTrack,
} from './ratings';
import {
  DEFAULT_CONFIDENCE_BASIS_POINTS,
  DRAW_BASIS_POINTS,
  LOSS_BASIS_POINTS,
  WIN_BASIS_POINTS,
} from './statistics';

/**
 * Story 7-2, AC1 to AC5.
 *
 * The interval arithmetic itself is `statistics.test.ts`'s subject and is not
 * re-tested here. What this file pins is everything the rating pipeline decides
 * *around* it: which Matches count, which Agents get a row, which table a row
 * lands in, and that a published number reproduces from its seed.
 */

const RESAMPLES = 500;
const SEED = 20260802;

function bot(id: string): AgentIdentity {
  return { id, kind: 'bot' };
}

function deployment(id: string, overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id,
    kind: 'deployment',
    deployment: { provider: 'groq', endpoint: 'https://example.invalid/v1', model: id },
    ...overrides,
  };
}

function byokDeployment(id: string): AgentIdentity {
  return {
    id,
    kind: 'deployment',
    deployment: { provider: 'byok', endpoint: 'https://example.invalid/v1', model: id },
  };
}

/**
 * A pairing played over `seeds` seeds from both sides, with the first Agent
 * winning `winsForFirst` of the Matches it plays on side 0.
 *
 * Both orientations of every seed, so the corpus clears 7.1's mirrored-seed
 * floor as well as its Match count -- the two are separate rules and a helper
 * that satisfied only one would make every case below test the wrong thing.
 */
function pairing(
  first: AgentIdentity,
  second: AgentIdentity,
  seeds: number,
  outcomeFor: (seed: number, firstOnSide0: boolean) => 'p1' | 'p2' | 'draw',
): LeaderboardMatch[] {
  const matches: LeaderboardMatch[] = [];
  for (let seed = 0; seed < seeds; seed += 1) {
    matches.push({
      matchId: `${first.id}-${second.id}-${String(seed)}-a`,
      seed,
      agents: [first, second],
      outcome: outcomeFor(seed, true),
    });
    matches.push({
      matchId: `${first.id}-${second.id}-${String(seed)}-b`,
      seed,
      agents: [second, first],
      outcome: outcomeFor(seed, false),
    });
  }
  return matches;
}

/** `first` always wins, whichever side it is standing on. */
function firstAlwaysWins(_seed: number, firstOnSide0: boolean): 'p1' | 'p2' {
  return firstOnSide0 ? 'p1' : 'p2';
}

function tracksFor(
  entries: readonly (readonly [AgentIdentity, RatingTrack])[],
): ReadonlyMap<string, RatingTrack> {
  return new Map(entries.map(([identity, track]) => [identity.id, track]));
}

const spacing = bot('spacing-aware');
const aggressive = bot('aggressive');

describe('computeLeaderboard scores a corpus (AC1)', () => {
  const matches = pairing(spacing, aggressive, 15, firstAlwaysWins);
  const leaderboard = computeLeaderboard({
    matches,
    tracks: tracksFor([
      [spacing, 'main'],
      [aggressive, 'main'],
    ]),
    resamples: RESAMPLES,
    seed: SEED,
  });

  it('rates the winner at a perfect score and the loser at zero', () => {
    expect(leaderboard.main.map((row) => row.agent)).toStrictEqual([
      'spacing-aware',
      'aggressive',
    ]);
    expect(leaderboard.main[0].ratingBasisPoints).toBe(WIN_BASIS_POINTS);
    expect(leaderboard.main[1].ratingBasisPoints).toBe(LOSS_BASIS_POINTS);
  });

  it('gives every row a confidence interval, never an optional one', () => {
    for (const row of [...leaderboard.main, ...leaderboard.reflex]) {
      expect(row.interval.sampleSize).toBe(row.matches);
      expect(row.interval.resamples).toBe(RESAMPLES);
      expect(row.interval.lowerBasisPoints).toBeLessThanOrEqual(row.ratingBasisPoints);
      expect(row.interval.upperBasisPoints).toBeGreaterThanOrEqual(row.ratingBasisPoints);
    }
  });

  it('counts a draw as half a point to each side', () => {
    const drawn = computeLeaderboard({
      matches: pairing(spacing, aggressive, 15, () => 'draw'),
      tracks: tracksFor([
        [spacing, 'main'],
        [aggressive, 'main'],
      ]),
      resamples: RESAMPLES,
      seed: SEED,
    });
    expect(drawn.main.map((row) => row.ratingBasisPoints)).toStrictEqual([
      DRAW_BASIS_POINTS,
      DRAW_BASIS_POINTS,
    ]);
  });

  it('reports the schedule each rating was earned against', () => {
    expect(leaderboard.main[0].opponents).toStrictEqual([
      { opponent: 'aggressive', matches: 30, scoreBasisPoints: WIN_BASIS_POINTS },
    ]);
  });

  it('states the bootstrap it used, so the numbers can be recomputed (AC5)', () => {
    expect(leaderboard.bootstrap).toStrictEqual({
      resamples: RESAMPLES,
      seed: SEED,
      confidenceBasisPoints: DEFAULT_CONFIDENCE_BASIS_POINTS,
    });
  });

  it('reproduces exactly from the same seed, and moves when the seed moves', () => {
    const again = computeLeaderboard({
      matches,
      tracks: tracksFor([
        [spacing, 'main'],
        [aggressive, 'main'],
      ]),
      resamples: RESAMPLES,
      seed: SEED,
    });
    expect(again).toStrictEqual(leaderboard);

    // A mixed corpus, so the interval has width to move. A degenerate all-wins
    // sample bootstraps to the same bounds under every seed, and comparing that
    // would assert nothing.
    //
    // Compared across five seeds rather than two: this sample takes only a
    // handful of distinct values, so two neighbouring seeds coinciding on both
    // bounds is ordinary rather than evidence the seed is ignored. What must be
    // true is that the seed reaches the resampling at all.
    const mixed = pairing(spacing, aggressive, 15, (seed, firstOnSide0) =>
      seed % 3 === 0 ? (firstOnSide0 ? 'p2' : 'p1') : firstOnSide0 ? 'p1' : 'p2',
    );
    const tracks = tracksFor([
      [spacing, 'main'],
      [aggressive, 'main'],
    ]);
    const bounds = new Set<string>();
    for (let offset = 0; offset < 12; offset += 1) {
      const board = computeLeaderboard({
        matches: mixed,
        tracks,
        resamples: RESAMPLES,
        seed: SEED + offset,
      });
      expect(board.main[0].ratingBasisPoints).toBe(6666);
      bounds.add(
        `${String(board.main[0].interval.lowerBasisPoints)}-${String(board.main[0].interval.upperBasisPoints)}`,
      );
    }
    expect(bounds.size).toBeGreaterThan(1);
  });

  it('gives each row its own resampling stream', () => {
    // Two pairings with byte-identical outcome patterns, so `bot-a` and `bot-c`
    // hold the same sample and the same mean. A single shared seed would
    // resample both along the identical index sequence and publish two
    // identical intervals, which a reader compares as independent evidence.
    // `deriveSeed(seed, rowIndex)` is what stops that.
    const pattern = (seed: number, firstOnSide0: boolean): 'p1' | 'p2' =>
      seed % 3 === 0 ? (firstOnSide0 ? 'p2' : 'p1') : firstOnSide0 ? 'p1' : 'p2';
    const [a, b, c, d] = ['bot-a', 'bot-b', 'bot-c', 'bot-d'].map(bot);

    const leaderboard = computeLeaderboard({
      matches: [...pairing(a, b, 15, pattern), ...pairing(c, d, 15, pattern)],
      tracks: tracksFor([
        [a, 'main'],
        [b, 'main'],
        [c, 'main'],
        [d, 'main'],
      ]),
      resamples: RESAMPLES,
      seed: SEED,
    });

    const [first, second] = leaderboard.main;
    expect([first.agent, second.agent]).toStrictEqual(['bot-a', 'bot-c']);
    expect(first.ratingBasisPoints).toBe(second.ratingBasisPoints);
    expect(first.interval.seed).not.toBe(second.interval.seed);
  });

  it('is independent of the order the Matches are supplied in', () => {
    const reversed = computeLeaderboard({
      matches: [...matches].reverse(),
      tracks: tracksFor([
        [spacing, 'main'],
        [aggressive, 'main'],
      ]),
      resamples: RESAMPLES,
      seed: SEED,
    });
    expect(reversed).toStrictEqual(leaderboard);
  });
});

describe('Baseline Bots are rows like any other entrant (AC2)', () => {
  const model = deployment('groq:some-model');
  const matches = [
    ...pairing(spacing, aggressive, 15, firstAlwaysWins),
    ...pairing(spacing, model, 15, firstAlwaysWins),
    ...pairing(aggressive, model, 15, firstAlwaysWins),
  ];

  it('puts both bots on the main leaderboard alongside the Deployment', () => {
    const leaderboard = computeLeaderboard({
      matches,
      tracks: tracksFor([
        [spacing, 'main'],
        [aggressive, 'main'],
        [model, 'main'],
      ]),
      resamples: RESAMPLES,
      seed: SEED,
    });
    expect(leaderboard.main.map((row) => row.agent)).toStrictEqual([
      'spacing-aware',
      'aggressive',
      'groq:some-model',
    ]);
    expect(leaderboard.main.map((row) => row.kind)).toStrictEqual([
      'bot',
      'bot',
      'deployment',
    ]);
  });

  it('rates a bot from its Matches against a Reflex-Track Deployment too', () => {
    // The bots are the calibration ladder. Discarding every Deployment-vs-Bot
    // Match as "cross-track" would throw away the whole corpus, because today
    // every Deployment is Reflex Track until a Metering Probe promotes it.
    const leaderboard = computeLeaderboard({
      matches,
      tracks: tracksFor([
        [spacing, 'main'],
        [aggressive, 'main'],
        [model, 'reflex'],
      ]),
      resamples: RESAMPLES,
      seed: SEED,
    });
    const spacingRow = leaderboard.main.find((row) => row.agent === 'spacing-aware');
    expect(spacingRow?.matches).toBe(60);
    expect(spacingRow?.opponents.map((opponent) => opponent.opponent)).toStrictEqual([
      'aggressive',
      'groq:some-model',
    ]);
  });
});

describe('the Reflex Track is a separate table (AC3, INV-5)', () => {
  const probed = deployment('groq:probed');
  const unprobed = deployment('groq:unprobed');
  const matches = [
    ...pairing(spacing, probed, 15, firstAlwaysWins),
    ...pairing(spacing, unprobed, 15, firstAlwaysWins),
    ...pairing(probed, unprobed, 15, firstAlwaysWins),
  ];
  const leaderboard = computeLeaderboard({
    matches,
    tracks: tracksFor([
      [spacing, 'main'],
      [probed, 'main'],
      [unprobed, 'reflex'],
    ]),
    resamples: RESAMPLES,
    seed: SEED,
  });

  it('never lets a Reflex-Track entry appear on the main leaderboard', () => {
    expect(leaderboard.main.map((row) => row.agent)).not.toContain('groq:unprobed');
    expect(leaderboard.reflex.map((row) => row.agent)).toStrictEqual(['groq:unprobed']);
    for (const row of leaderboard.main) {
      expect(row.track).toBe('main');
    }
  });

  it('partitions every rated row into exactly one of the two tables', () => {
    const ids = [...leaderboard.main, ...leaderboard.reflex].map((row) => row.agent);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
  });

  it('gives a Reflex-Track row the same interval it would have had on the main table', () => {
    // The row order -- and therefore each row's bootstrap stream -- is fixed
    // before the partition, so demoting an entrant cannot silently move
    // somebody else's published interval.
    const allMain = computeLeaderboard({
      matches,
      tracks: tracksFor([
        [spacing, 'main'],
        [probed, 'main'],
        [unprobed, 'main'],
      ]),
      resamples: RESAMPLES,
      seed: SEED,
    });
    expect([...leaderboard.main, ...leaderboard.reflex].map((row) => row.interval)).toStrictEqual(
      allMain.main.map((row) => row.interval),
    );
  });

  it('refuses an Agent it was given no track for', () => {
    expect(() =>
      computeLeaderboard({
        matches,
        tracks: tracksFor([
          [spacing, 'main'],
          [probed, 'main'],
        ]),
        resamples: RESAMPLES,
        seed: SEED,
      }),
    ).toThrow(/no track supplied for "groq:unprobed"/);
  });

  it('refuses a supplied track that contradicts the logged one', () => {
    const logged = deployment('groq:logged-reflex', { track: 'reflex' });
    expect(() =>
      computeLeaderboard({
        matches: pairing(spacing, logged, 15, firstAlwaysWins),
        tracks: tracksFor([
          [spacing, 'main'],
          [logged, 'main'],
        ]),
        resamples: RESAMPLES,
        seed: SEED,
      }),
    ).toThrow(/logged as track "reflex" but the supplied map says "main"/);
  });
});

describe('BYOK Matches are excluded entirely (AC4, AD-11)', () => {
  const visitor = byokDeployment('byok:some-model');

  it('rates none of them, and says so per Match', () => {
    const matches = [
      ...pairing(spacing, aggressive, 15, firstAlwaysWins),
      ...pairing(spacing, visitor, 15, firstAlwaysWins),
    ];
    const leaderboard = computeLeaderboard({
      matches,
      tracks: tracksFor([
        [spacing, 'main'],
        [aggressive, 'main'],
        [visitor, 'reflex'],
      ]),
      resamples: RESAMPLES,
      seed: SEED,
    });

    expect(leaderboard.ratedMatches).toBe(30);
    expect(leaderboard.excludedMatches).toHaveLength(30);
    for (const excluded of leaderboard.excludedMatches) {
      expect(excluded.exclusions).toStrictEqual(['byok']);
      expect(excluded.reason).toMatch(/BYOK Matches are excluded/);
    }
    // The visitor's Agent contributed to nobody's rating, including its own.
    expect(leaderboard.main.find((row) => row.agent === 'spacing-aware')?.matches).toBe(30);
    expect(leaderboard.unrated.map((row) => row.agent)).toStrictEqual(['byok:some-model']);
  });

  it('does not let a BYOK Match push a pairing over the coverage floor', () => {
    // The laundering attempt this order of operations exists to refuse: the
    // same Deployment id, run once through a visitor's own key, on the one
    // mirrored seed that would carry the pairing from 28 Matches to 30 and from
    // 14 mirrored seeds to 15. Both floors are cleared on a naive count, and
    // neither is cleared once BYOK is removed first.
    const model = deployment('groq:some-model');
    const sameModelOnAVisitorKey = byokDeployment('groq:some-model');

    const leaderboard = computeLeaderboard({
      matches: [
        ...pairing(spacing, model, 14, firstAlwaysWins),
        ...pairing(spacing, sameModelOnAVisitorKey, 1, firstAlwaysWins).map((match, index) => ({
          ...match,
          matchId: `byok-${String(index)}`,
          seed: 14,
        })),
      ],
      tracks: tracksFor([
        [spacing, 'main'],
        [model, 'main'],
      ]),
      resamples: RESAMPLES,
      seed: SEED,
    });

    expect(leaderboard.ratedMatches).toBe(0);
    expect(leaderboard.main).toHaveLength(0);
    expect(leaderboard.coverage[0].matches).toBe(28);
    expect(leaderboard.coverage[0].mirroredSeeds).toBe(14);
  });
});

describe('the coverage floor decides what is rated (7-1 AC3)', () => {
  it('rates nothing from a pairing below the Match floor', () => {
    const matches = pairing(spacing, aggressive, 14, firstAlwaysWins);
    const leaderboard = computeLeaderboard({
      matches,
      tracks: tracksFor([
        [spacing, 'main'],
        [aggressive, 'main'],
      ]),
      resamples: RESAMPLES,
      seed: SEED,
    });

    expect(leaderboard.ratedMatches).toBe(0);
    expect(leaderboard.main).toHaveLength(0);
    expect(leaderboard.reflex).toHaveLength(0);
    expect(leaderboard.unrated.map((row) => row.agent)).toStrictEqual([
      'aggressive',
      'spacing-aware',
    ]);
    expect(leaderboard.excludedMatches[0].exclusions).toStrictEqual([
      'insufficient-matches',
      'insufficient-mirrored-seeds',
    ]);
    expect(leaderboard.excludedMatches[0].reason).toMatch(/Provisional, not rated/);
  });

  it('rates a covered pairing while excluding an uncovered one in the same corpus', () => {
    const model = deployment('groq:some-model');
    const leaderboard = computeLeaderboard({
      matches: [
        ...pairing(spacing, aggressive, 15, firstAlwaysWins),
        ...pairing(spacing, model, 3, firstAlwaysWins),
      ],
      tracks: tracksFor([
        [spacing, 'main'],
        [aggressive, 'main'],
        [model, 'main'],
      ]),
      resamples: RESAMPLES,
      seed: SEED,
    });

    expect(leaderboard.ratedMatches).toBe(30);
    expect(leaderboard.main.map((row) => row.agent)).toStrictEqual([
      'spacing-aware',
      'aggressive',
    ]);
    expect(leaderboard.unrated.map((row) => row.agent)).toStrictEqual(['groq:some-model']);
    expect(leaderboard.main[0].matches).toBe(30);
  });

  it('excludes a pairing played 30 times from one side only', () => {
    // 30 Matches, 30 seeds, zero of them mirrored: the count rule alone would
    // pass this, and it is exactly the corpus Story 7-1 exists to refuse.
    const matches: LeaderboardMatch[] = [];
    for (let seed = 0; seed < 30; seed += 1) {
      matches.push({
        matchId: `one-sided-${String(seed)}`,
        seed,
        agents: [spacing, aggressive],
        outcome: 'p1',
      });
    }
    const leaderboard = computeLeaderboard({
      matches,
      tracks: tracksFor([
        [spacing, 'main'],
        [aggressive, 'main'],
      ]),
      resamples: RESAMPLES,
      seed: SEED,
    });

    expect(leaderboard.ratedMatches).toBe(0);
    expect(leaderboard.excludedMatches[0].exclusions).toStrictEqual([
      'insufficient-mirrored-seeds',
    ]);
  });
});

describe('nothing falls out of the accounting', () => {
  const model = deployment('groq:some-model');
  const visitor = byokDeployment('byok:some-model');
  const matches = [
    ...pairing(spacing, aggressive, 15, firstAlwaysWins),
    ...pairing(spacing, model, 3, firstAlwaysWins),
    ...pairing(aggressive, visitor, 15, firstAlwaysWins),
  ];
  const leaderboard = computeLeaderboard({
    matches,
    tracks: tracksFor([
      [spacing, 'main'],
      [aggressive, 'main'],
      [model, 'main'],
      [visitor, 'reflex'],
    ]),
    resamples: RESAMPLES,
    seed: SEED,
  });

  it('accounts for every Match exactly once', () => {
    expect(leaderboard.matches).toBe(matches.length);
    expect(leaderboard.ratedMatches + leaderboard.excludedMatches.length).toBe(matches.length);
  });

  it('gives every excluded Match a stated reason', () => {
    for (const excluded of leaderboard.excludedMatches) {
      expect(excluded.exclusions.length).toBeGreaterThan(0);
      expect(excluded.reason).not.toBe('');
    }
  });

  it('gives every Agent in the corpus either a row or an unrated entry', () => {
    const named = new Set<string>([
      ...leaderboard.main.map((row) => row.agent),
      ...leaderboard.reflex.map((row) => row.agent),
      ...leaderboard.unrated.map((row) => row.agent),
    ]);
    expect([...named].sort()).toStrictEqual([
      'aggressive',
      'byok:some-model',
      'groq:some-model',
      'spacing-aware',
    ]);
  });

  it('publishes coverage for every pairing, including the excluded ones', () => {
    expect(leaderboard.coverage.map((row) => row.pairing.join(' vs '))).toStrictEqual([
      'aggressive vs spacing-aware',
      'groq:some-model vs spacing-aware',
    ]);
  });
});

describe('degenerate input is refused rather than absorbed', () => {
  const tracks = tracksFor([
    [spacing, 'main'],
    [aggressive, 'main'],
  ]);

  it('refuses a Match of an Agent against itself', () => {
    expect(() =>
      computeLeaderboard({
        matches: [{ matchId: 'self', seed: 1, agents: [spacing, spacing], outcome: 'draw' }],
        tracks,
        resamples: RESAMPLES,
        seed: SEED,
      }),
    ).toThrow(/pairs "spacing-aware" with itself/);
  });

  it('refuses a non-integer seed', () => {
    expect(() =>
      computeLeaderboard({
        matches: [
          { matchId: 'fractional', seed: Number.NaN, agents: [spacing, aggressive], outcome: 'draw' },
        ],
        tracks,
        resamples: RESAMPLES,
        seed: SEED,
      }),
    ).toThrow(/non-integer seed/);
  });

  it('refuses one id used for both a Deployment and a Bot (INV-6)', () => {
    const collision: AgentIdentity = { id: 'spacing-aware', kind: 'deployment' };
    expect(() =>
      computeLeaderboard({
        matches: [
          { matchId: 'a', seed: 1, agents: [spacing, aggressive], outcome: 'p1' },
          { matchId: 'b', seed: 1, agents: [collision, aggressive], outcome: 'p1' },
        ],
        tracks,
        resamples: RESAMPLES,
        seed: SEED,
      }),
    ).toThrow(/appears as both a bot and a deployment/);
  });

  it('returns empty tables rather than throwing on an empty corpus', () => {
    const leaderboard = computeLeaderboard({
      matches: [],
      tracks: new Map(),
      resamples: RESAMPLES,
      seed: SEED,
    });
    expect(leaderboard.main).toHaveLength(0);
    expect(leaderboard.reflex).toHaveLength(0);
    expect(leaderboard.ratedMatches).toBe(0);
    expect(leaderboard.bootstrap.confidenceBasisPoints).toBe(DEFAULT_CONFIDENCE_BASIS_POINTS);
  });
});
