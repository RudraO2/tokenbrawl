import type { AgentIdentity } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { computeBehaviouralMetrics } from './behavioural-metrics';
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

/**
 * Story 7-3: behaviour beside skill.
 *
 * AC2 and AC4 are claims about what the published document says, so they are
 * tested against the rendered Markdown rather than against the JSON. AC3's
 * `null`-versus-zero rule is `behavioural-metrics.test.ts`'s subject at the
 * arithmetic level; what is pinned here is that the renderer prints the words.
 */

describe('behavioural metrics ride beside the ratings (7-3, AC1)', () => {
  const behaviour = computeBehaviouralMetrics([
    {
      schemaVersion: '1.0.0',
      matchId: 'spacing-aware-unprobed-0-a',
      environment: { id: 'fighter-1v1', version: '1.0.0' },
      seed: 0,
      configHash: 'abc123',
      agents: [spacing, unprobed],
      decisions: [
        { tick: 0, agentIndex: 0, action: 'advance' },
        {
          tick: 0,
          agentIndex: 1,
          action: 'attack',
          tokensSpent: 300,
          reasoningTokens: 90,
          bankRemaining: 40,
          reflexMode: false,
        },
        {
          tick: 1,
          agentIndex: 1,
          action: 'stand',
          tokensSpent: 100,
          reasoningTokens: 10,
          bankRemaining: 0,
          reflexMode: false,
          parseFailure: true,
          rawResponse: 'I would like to attack.',
        },
      ],
      result: { outcome: 'p1', endTick: 2, endReason: 'ko', healthRemaining: [10, 0] },
      finalStateHash: 'final',
    },
  ]);

  const withBehaviour = buildLeaderboardReport(leaderboard, META, behaviour);
  const rendered = renderLeaderboardMarkdown(withBehaviour);

  /**
   * The behavioural section only. A rating row and a behaviour row both begin
   * `| <agent> | <kind> |`, so a document-wide search finds the wrong one --
   * which is itself worth knowing, and is why the behaviour header says
   * `Entrant` rather than `Agent`.
   */
  const behaviourSection = rendered.slice(rendered.indexOf('## How the tokens were spent'));

  function behaviourRow(agent: string): string {
    const line = behaviourSection
      .split('\n')
      .find((entry) => entry.startsWith(`| ${agent} |`));
    if (line === undefined) {
      throw new Error(`no behaviour row rendered for ${agent}`);
    }
    return line;
  }

  it('emits one behaviour row per rated Agent, in table order', () => {
    expect(withBehaviour.behaviour.map((row) => row.agent)).toStrictEqual([
      ...leaderboard.main.map((row) => row.agent),
      ...leaderboard.reflex.map((row) => row.agent),
    ]);
  });

  it('carries the measured figures through for the Agent the corpus covers', () => {
    const row = withBehaviour.behaviour.find((entry) => entry.agent === unprobed.id);
    expect(row?.tokensPerMatch).toBe(400);
    expect(row?.reasoningShareBasisPoints).toBe(2500);
    expect(row?.parseFailureRateBasisPoints).toBe(5000);
    expect(row?.bankExhaustionRateBasisPoints).toBe(10000);
    expect(row?.track).toBe('reflex');
  });

  it('renders every one of the four metrics as its own column', () => {
    const header = rendered
      .split('\n')
      .find((line) => line.startsWith('| Entrant | Kind | Track |'));
    expect(header).toContain('Tokens / Match');
    expect(header).toContain('Reasoning share');
    expect(header).toContain('Parse failures');
    expect(header).toContain('Bank exhausted');
  });

  it('gives an Agent no log covers a not-reported row rather than a row of zeroes (AC3)', () => {
    const row = withBehaviour.behaviour.find((entry) => entry.agent === aggressive.id);
    expect(row?.tokensPerMatch).toBeNull();
    expect(row?.reasoningShareBasisPoints).toBeNull();
    expect(row?.bankExhaustionRateBasisPoints).toBeNull();

    const line = behaviourRow(aggressive.id);
    expect(row?.parseFailureRateBasisPoints).toBeNull();
    // Five silent cells: tokens, reasoning share, parse failures, rate limits,
    // bank exhaustion. Nothing about this entrant was measured, and the row
    // says so five times rather than printing five zeroes.
    expect(line.split('|').filter((cell) => cell.trim() === 'not reported')).toHaveLength(5);
  });

  it('never writes a not-reported quantity as a number of any shape', () => {
    // The mutation this guards: a `?? 0` anywhere in the renderer would publish
    // an unmeasured entrant as a frugal one. Checked as "this row carries no
    // number at all" rather than as "no bare zero", because `0.0000` and `0`
    // are the same lie in two typefaces -- an earlier version of this test
    // caught only the second, and the mutation that proved it fails two cases
    // now rather than one.
    const values = behaviourRow(aggressive.id)
      .split('|')
      .slice(4, -1)
      .map((cell) => cell.trim());
    expect(values).toStrictEqual(Array.from({ length: 5 }, () => 'not reported'));
    expect(values.join(' ')).not.toMatch(/\d/);
  });

  it('keeps the behaviour table out of the rating-table shape, so it needs no CI column', () => {
    // `| Agent | Kind |` is how every check in this repo recognises a table
    // that owes the reader an interval. This one is not that table.
    expect(rendered).not.toContain('| Agent | Kind | Track |');
  });

  it('states the denominator behind the rate, and reports a measured zero as zero', () => {
    const line = behaviourRow(unprobed.id);
    expect(line).toContain('(1 of 2)');
    // Nothing was rate-limited, and that is a measured zero, not a silence.
    expect(line).toContain('0.0000 (0 of 2)');
  });
});

describe('a Deployment beaten by a Baseline Bot is the headline (7-3, AC2)', () => {
  const loser = deployment('groq:loser');
  const beaten = computeLeaderboard({
    matches: [
      ...pairing(spacing, aggressive, 15, firstWins),
      ...pairing(spacing, loser, 15, firstWins),
      ...pairing(aggressive, loser, 15, firstWins),
    ],
    tracks: tracksFor([
      [spacing, 'main'],
      [aggressive, 'main'],
      [loser, 'main'],
    ]),
    resamples: RESAMPLES,
    seed: SEED,
  });
  const beatenReport = buildLeaderboardReport(beaten, META);
  const beatenMarkdown = renderLeaderboardMarkdown(beatenReport);

  it('names the bot and how many Deployments it outranks', () => {
    expect(beatenReport.headline).toContain('spacing-aware');
    expect(beatenReport.headline).toContain('1 of 1 Deployment');
  });

  it('prints it above both tables, not as a footnote', () => {
    const headlineAt = beatenMarkdown.indexOf('outranks');
    const mainAt = beatenMarkdown.indexOf('## Main leaderboard');
    expect(headlineAt).toBeGreaterThan(-1);
    expect(headlineAt).toBeLessThan(mainAt);
  });

  it('still publishes the beaten Deployment as an ordinary row (not hidden, not filtered)', () => {
    const row = beatenMarkdown
      .split('\n')
      .find((line) => line.startsWith(`| ${loser.id} | deployment |`));
    expect(row).toBeDefined();
    // With its interval, like every other rating in this repo.
    expect(row).toMatch(/\d+\.\d{4} – \d+\.\d{4}/);
    expect(beaten.main.map((entry) => entry.agent)).toContain(loser.id);
  });

  it('is null, and renders nothing, when no bot outranks a Deployment', () => {
    // The default corpus has no Deployment on the main board at all, so there
    // is nothing for a bot to outrank and no sentence to invent.
    expect(report.headline).toBeNull();
    expect(markdown).not.toContain('outranks');
  });

  it('never compares across tracks, which would be the claim INV-5 forbids', () => {
    const crossTrack = computeLeaderboard({
      matches: [
        ...pairing(spacing, aggressive, 15, firstWins),
        ...pairing(spacing, unprobed, 15, firstWins),
        ...pairing(aggressive, unprobed, 15, firstWins),
      ],
      tracks: tracksFor([
        [spacing, 'main'],
        [aggressive, 'main'],
        [unprobed, 'reflex'],
      ]),
      resamples: RESAMPLES,
      seed: SEED,
    });
    // Both bots sit on the main board with no Deployment beside them; the only
    // Deployment is Reflex Track with no bot beside it.
    expect(buildLeaderboardReport(crossTrack, META).headline).toBeNull();
  });
});

describe('the parse-failure rate is framed as a measurement (7-3, AC4)', () => {
  const framed = renderLeaderboardMarkdown(buildLeaderboardReport(leaderboard, META));

  it('says what the number is, and what it is not', () => {
    expect(framed).toContain('is a *measurement*');
    expect(framed).toContain('not a fault to be driven down');
  });

  it('uses no defect vocabulary anywhere in the document', () => {
    // A later story that turns this into a KPI goes red here rather than
    // shipping a benchmark that punishes a model for being measured.
    for (const word of [
      'target',
      'acceptable',
      'should be reduced',
      'budget',
      'regression',
      'sla',
      'threshold',
      'tolerance',
    ]) {
      expect(framed.toLowerCase()).not.toContain(word);
    }
  });

  it('publishes the rate-limited share separately, so the total never overstates the model', () => {
    expect(framed).toContain('the provider refused rather than the model fumbled');
  });
});
