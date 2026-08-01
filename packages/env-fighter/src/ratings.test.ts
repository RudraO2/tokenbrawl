import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeLeaderboard, type Leaderboard } from '../../core/src/ratings';
import {
  buildLeaderboardReport,
  renderLeaderboardMarkdown,
  type LeaderboardReport,
} from '../../core/src/ratings-report';
import { WIN_BASIS_POINTS } from '../../core/src/statistics';
import {
  BASELINE_RATINGS_BOOTSTRAP_RESAMPLES,
  BASELINE_RATINGS_BOOTSTRAP_SEED,
  BASELINE_RATINGS_REPORT_MARKDOWN_PATH,
  BASELINE_RATINGS_REPORT_PATH,
  baselineRatingsMeta,
  ladderLeaderboardMatches,
  ladderTracks,
} from './testing/make-ratings-report';
import { LADDER_SEED_COUNT, runSkillLadder, type LadderRun } from './testing/skill-ladder';

/**
 * Story 7-2 AC2 and AC5 against the real Environment.
 *
 * `packages/core/src/ratings.test.ts` unit-tests the pipeline against synthetic
 * corpora. What this file adds is what a unit test cannot: the same code run
 * over 600 real Matches, and a committed report that goes red the moment a
 * published number moves.
 *
 * Regenerate the committed artefacts with:
 *   TOKENBRAWL_WRITE_RATINGS_REPORT=1 npx vitest run --root packages/env-fighter \
 *     src/ratings.test.ts
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WRITE_REPORT = process.env.TOKENBRAWL_WRITE_RATINGS_REPORT === '1';

/** One ladder run shared by every case: 600 Matches, ~1s. */
const run: LadderRun = await runSkillLadder();
const matches = ladderLeaderboardMatches(run);
const leaderboard: Leaderboard = computeLeaderboard({
  matches,
  tracks: ladderTracks(run),
  resamples: BASELINE_RATINGS_BOOTSTRAP_RESAMPLES,
  seed: BASELINE_RATINGS_BOOTSTRAP_SEED,
});
const report: LeaderboardReport = buildLeaderboardReport(leaderboard, baselineRatingsMeta(run));

describe('the ladder corpus is rated end to end', () => {
  it('rates every Match, because every ladder pairing clears the coverage floor', () => {
    expect(matches).toHaveLength(run.pairings.length * LADDER_SEED_COUNT * 2);
    expect(leaderboard.ratedMatches).toBe(matches.length);
    expect(leaderboard.excludedMatches).toHaveLength(0);
    expect(leaderboard.unrated).toHaveLength(0);
  });

  it('re-expresses each Match from side 0’s point of view, not the stronger bot’s', () => {
    for (const pairing of run.pairings) {
      for (const ladderMatch of pairing.matches) {
        const rated = matches.find((entry) => entry.matchId === ladderMatch.matchId);
        expect(rated).toBeDefined();
        const side0Score =
          ladderMatch.strongerAgentIndex === 0
            ? ladderMatch.scoreBasisPoints
            : WIN_BASIS_POINTS - ladderMatch.scoreBasisPoints;
        expect(rated?.outcome).toBe(
          side0Score === WIN_BASIS_POINTS ? 'p1' : side0Score === 0 ? 'p2' : 'draw',
        );
        expect(rated?.agents[ladderMatch.strongerAgentIndex].id).toBe(pairing.stronger);
      }
    }
  });
});

describe('the Baseline Bots are rows with intervals (AC1, AC2)', () => {
  it('puts all three on the main leaderboard and nothing on the Reflex Track', () => {
    expect(leaderboard.main.map((row) => row.agent)).toStrictEqual([
      'spacing-aware',
      'aggressive',
      'random',
    ]);
    expect(leaderboard.reflex).toHaveLength(0);
    for (const row of leaderboard.main) {
      expect(row.kind).toBe('bot');
      expect(row.matches).toBe(LADDER_SEED_COUNT * 4);
      expect(row.opponents).toHaveLength(2);
    }
  });

  it('orders them the way the skill-separation gate does', () => {
    // Not a coincidence to be pleased about -- if the rating pipeline ranked
    // the three bots differently from the gate that calibrated them, one of the
    // two would be wrong, and the gate is the one with committed thresholds.
    const ratings = leaderboard.main.map((row) => row.ratingBasisPoints);
    expect(ratings[0]).toBeGreaterThan(ratings[1]);
    expect(ratings[1]).toBeGreaterThan(ratings[2]);
  });

  it('gives every row an interval that brackets its rating', () => {
    for (const row of leaderboard.main) {
      expect(row.interval.resamples).toBe(BASELINE_RATINGS_BOOTSTRAP_RESAMPLES);
      expect(row.interval.lowerBasisPoints).toBeLessThanOrEqual(row.ratingBasisPoints);
      expect(row.interval.upperBasisPoints).toBeGreaterThanOrEqual(row.ratingBasisPoints);
    }
  });
});

describe('the published numbers reproduce (AC5)', () => {
  it('recomputes identically from a second, independent ladder run', async () => {
    const second = await runSkillLadder();
    expect(
      computeLeaderboard({
        matches: ladderLeaderboardMatches(second),
        tracks: ladderTracks(second),
        resamples: BASELINE_RATINGS_BOOTSTRAP_RESAMPLES,
        seed: BASELINE_RATINGS_BOOTSTRAP_SEED,
      }),
    ).toStrictEqual(leaderboard);
  });

  it('uses its own resampling seed, not the gate’s or the side-advantage report’s', () => {
    expect(leaderboard.bootstrap.seed).toBe(BASELINE_RATINGS_BOOTSTRAP_SEED);
    expect(leaderboard.bootstrap.resamples).toBe(BASELINE_RATINGS_BOOTSTRAP_RESAMPLES);
  });
});

describe('the committed report', () => {
  it('matches a fresh run byte for byte', () => {
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const markdown = renderLeaderboardMarkdown(report);

    if (WRITE_REPORT) {
      writeFileSync(join(REPO_ROOT, BASELINE_RATINGS_REPORT_PATH), json, 'utf8');
      writeFileSync(join(REPO_ROOT, BASELINE_RATINGS_REPORT_MARKDOWN_PATH), markdown, 'utf8');
    }

    expect(readFileSync(join(REPO_ROOT, BASELINE_RATINGS_REPORT_PATH), 'utf8')).toBe(json);
    expect(readFileSync(join(REPO_ROOT, BASELINE_RATINGS_REPORT_MARKDOWN_PATH), 'utf8')).toBe(
      markdown,
    );
  });

  it('records the configuration the corpus was played under', () => {
    expect(report.configHash).toBe(run.configHash);
    expect(report.environment).toStrictEqual(run.environment);
    expect(report.corpus).toContain(String(run.seedBase));
  });

  it('publishes a CI beside every rating it prints', () => {
    const markdown = renderLeaderboardMarkdown(report);
    for (const row of report.mainLeaderboard) {
      const line = markdown
        .split('\n')
        .find((candidate) => candidate.startsWith(`| ${row.agent} | bot |`));
      expect(line).toBeDefined();
      expect(line).toMatch(/\| \d+\.\d{4} \| \d+\.\d{4} – \d+\.\d{4} \|$/);
    }
  });

  it('carries the story key in a form the INV-2 float sweep cannot mistake for a literal', () => {
    expect(report.story).toBe('7-2-ratings-with-confidence-intervals');
  });
});
