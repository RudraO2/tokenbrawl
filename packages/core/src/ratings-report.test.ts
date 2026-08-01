import type { AgentIdentity } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { computeLeaderboard, type LeaderboardMatch, type RatingTrack } from './ratings';
import {
  buildLeaderboardReport,
  renderLeaderboardMarkdown,
  type LeaderboardReportMeta,
} from './ratings-report';

/**
 * Story 7-2 AC1, second sentence: **no raw win table is ever published without
 * CIs.** This file is where that is a test rather than an intention -- every
 * rating table this renderer can emit is inspected cell by cell.
 *
 * `publication-discipline.test.ts` in `packages/cli` runs the complementary
 * sweep over the committed artefacts themselves, catching a table written by
 * some future story that never came through here at all.
 */

const RESAMPLES = 200;
const SEED = 20260802;

const META: LeaderboardReportMeta = {
  story: '7-2-ratings-with-confidence-intervals',
  title: 'Test leaderboard',
  generatedBy: 'npx vitest run --root packages/core src/ratings-report.test.ts',
  corpus: 'a synthetic corpus',
  environment: { id: 'fighter-1v1', version: '1.0.0' },
  configHash: 'abc123',
};

function bot(id: string): AgentIdentity {
  return { id, kind: 'bot' };
}

function deployment(id: string, provider: 'groq' | 'byok' = 'groq'): AgentIdentity {
  return {
    id,
    kind: 'deployment',
    deployment: { provider, endpoint: 'https://example.invalid/v1', model: id },
  };
}

function pairing(
  first: AgentIdentity,
  second: AgentIdentity,
  seeds: number,
  outcome: (seed: number, firstOnSide0: boolean) => 'p1' | 'p2' | 'draw',
): LeaderboardMatch[] {
  const matches: LeaderboardMatch[] = [];
  for (let seed = 0; seed < seeds; seed += 1) {
    matches.push({
      matchId: `${first.id}-${second.id}-${String(seed)}-a`,
      seed,
      agents: [first, second],
      outcome: outcome(seed, true),
    });
    matches.push({
      matchId: `${first.id}-${second.id}-${String(seed)}-b`,
      seed,
      agents: [second, first],
      outcome: outcome(seed, false),
    });
  }
  return matches;
}

const firstWins = (_seed: number, firstOnSide0: boolean): 'p1' | 'p2' =>
  firstOnSide0 ? 'p1' : 'p2';

const spacing = bot('spacing-aware');
const aggressive = bot('aggressive');
const probed = deployment('groq:probed');
const unprobed = deployment('groq:unprobed');
const visitor = deployment('byok:visitor', 'byok');

function tracksFor(
  entries: readonly (readonly [AgentIdentity, RatingTrack])[],
): ReadonlyMap<string, RatingTrack> {
  return new Map(entries.map(([identity, track]) => [identity.id, track]));
}

const leaderboard = computeLeaderboard({
  matches: [
    ...pairing(spacing, aggressive, 15, firstWins),
    ...pairing(spacing, unprobed, 15, firstWins),
    ...pairing(aggressive, unprobed, 15, firstWins),
    // Below the coverage floor: a provisional pairing, published as such.
    ...pairing(spacing, probed, 4, firstWins),
    // Excluded outright (AD-11).
    ...pairing(aggressive, visitor, 15, firstWins),
  ],
  tracks: tracksFor([
    [spacing, 'main'],
    [aggressive, 'main'],
    [probed, 'main'],
    [unprobed, 'reflex'],
    [visitor, 'reflex'],
  ]),
  resamples: RESAMPLES,
  seed: SEED,
});

const report = buildLeaderboardReport(leaderboard, META);
const markdown = renderLeaderboardMarkdown(report);
const lines = markdown.split('\n');

/** Every `|`-delimited row that follows a rating-table header, in document order. */
function ratingTableRows(): readonly string[] {
  const rows: string[] = [];
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith('| Agent | Kind |')) {
      inTable = true;
      continue;
    }
    if (!inTable) {
      continue;
    }
    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }
    if (line.startsWith('| --- ')) {
      continue;
    }
    rows.push(line);
  }
  return rows;
}

describe('a rating is never published without its interval (AC1)', () => {
  it('heads every rating table with a CI column', () => {
    const headers = lines.filter((line) => line.startsWith('| Agent | Kind |'));
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      expect(header).toContain('| Rating | CI |');
    }
  });

  it('gives every rating row a rendered interval in its last cell', () => {
    const rows = ratingTableRows();
    expect(rows).toHaveLength(leaderboard.main.length + leaderboard.reflex.length);
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim());
      // Leading and trailing empties from the delimiters at both ends.
      expect(cells).toHaveLength(8);
      expect(cells[5]).toMatch(/^\d+\.\d{4}$/);
      expect(cells[6]).toMatch(/^\d+\.\d{4} – \d+\.\d{4}$/);
    }
  });

  it('states the coverage the intervals were computed at, once, in the preamble', () => {
    expect(markdown).toContain(
      `seeded percentile bootstrap, ${String(RESAMPLES)} resamples, seed ${String(SEED)}, 0.9500 coverage`,
    );
  });

  it('renders an empty table as a stated absence rather than a bare header', () => {
    const empty = computeLeaderboard({
      matches: pairing(spacing, aggressive, 2, firstWins),
      tracks: tracksFor([
        [spacing, 'main'],
        [aggressive, 'main'],
      ]),
      resamples: RESAMPLES,
      seed: SEED,
    });
    const rendered = renderLeaderboardMarkdown(buildLeaderboardReport(empty, META));
    expect(rendered).toContain('_No rated entry on the main leaderboard.');
    expect(rendered).not.toContain('| Agent | Kind |');
  });
});

describe('the Reflex Track is a labelled table of its own (AC3)', () => {
  it('gives it its own heading, after the main leaderboard', () => {
    const main = lines.indexOf('## Main leaderboard');
    const reflex = lines.indexOf('## Reflex Track');
    expect(main).toBeGreaterThan(-1);
    expect(reflex).toBeGreaterThan(main);
  });

  it('never prints a Reflex-Track entry inside the main table', () => {
    const main = lines.indexOf('## Main leaderboard');
    const reflex = lines.indexOf('## Reflex Track');
    const mainSection = lines.slice(main, reflex).join('\n');
    expect(mainSection).toContain('spacing-aware');
    expect(mainSection).not.toContain('groq:unprobed');
  });

  it('says why an entry is on it', () => {
    expect(markdown).toContain('Metering Probe');
    expect(markdown).toContain('INV-5');
  });
});

describe('the Baseline Bots are rows (AC2)', () => {
  it('prints both of them, marked as bots', () => {
    expect(markdown).toContain('| spacing-aware | bot |');
    expect(markdown).toContain('| aggressive | bot |');
  });
});

describe('what was left out is published too', () => {
  it('names every unrated Agent and why', () => {
    expect(markdown).toContain('## Not rated');
    expect(markdown).toContain('| groq:probed | deployment | main |');
    expect(markdown).toContain('| byok:visitor | deployment | reflex |');
  });

  it('publishes the coverage of every pairing, provisional ones included', () => {
    expect(markdown).toContain('| groq:probed vs spacing-aware | 8 | 4 / 4 | 4 | provisional (');
  });

  it('totals the exclusions per reason', () => {
    expect(markdown).toContain('## Excluded Matches');
    expect(report.exclusionTotals).toStrictEqual([
      { exclusion: 'byok', matches: 30 },
      { exclusion: 'insufficient-matches', matches: 8 },
      { exclusion: 'insufficient-mirrored-seeds', matches: 8 },
    ]);
  });
});

describe('the JSON artefact', () => {
  it('carries both CI bounds on every row', () => {
    for (const row of [...report.mainLeaderboard, ...report.reflexTrack]) {
      expect(Number.isSafeInteger(row.ciLowerBasisPoints)).toBe(true);
      expect(Number.isSafeInteger(row.ciUpperBasisPoints)).toBe(true);
      expect(row.ciLowerBasisPoints).toBeLessThanOrEqual(row.ratingBasisPoints);
      expect(row.ciUpperBasisPoints).toBeGreaterThanOrEqual(row.ratingBasisPoints);
    }
  });

  it('holds no floating-point number anywhere', () => {
    // Every rate in this repo is integer basis points (INV-2). A float in a
    // committed artefact is how a report starts rendering differently on two
    // machines.
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'number') {
        expect(Number.isSafeInteger(value), `${path} is not a safe integer`).toBe(true);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => {
          walk(entry, `${path}[${String(index)}]`);
        });
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
          walk(entry, `${path}.${key}`);
        }
      }
    };
    walk(JSON.parse(JSON.stringify(report)), 'report');
  });

  it('round-trips through JSON unchanged, so the committed bytes are the object', () => {
    expect(JSON.parse(JSON.stringify(report))).toStrictEqual(report);
  });
});
