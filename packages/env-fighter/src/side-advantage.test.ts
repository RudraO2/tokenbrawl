import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { summarisePairingCoverage } from '../../core/src/pairing-coverage';
import {
  NEUTRAL_SIDE_SCORE_BASIS_POINTS,
  summariseSideAdvantage,
  type SideAdvantageSummary,
} from '../../core/src/side-advantage';
import { WIN_BASIS_POINTS } from '../../core/src/statistics';
import {
  SIDE_ADVANTAGE_BOOTSTRAP_RESAMPLES,
  SIDE_ADVANTAGE_BOOTSTRAP_SEED,
  SIDE_ADVANTAGE_REPORT_MARKDOWN_PATH,
  SIDE_ADVANTAGE_REPORT_PATH,
  buildSideAdvantageReport,
  formatSignedBasisPoints,
  ladderSideAdvantageMatches,
  renderSideAdvantageMarkdown,
  type SideAdvantageReport,
} from './testing/make-side-advantage-report';
import { LADDER_SEED_COUNT, runSkillLadder, type LadderRun } from './testing/skill-ladder';

/**
 * Story 7.1 AC4 -- "any side advantage in the Environment is measurable from
 * the published results and reported".
 *
 * The estimator itself is unit-tested against synthetic biased corpora in
 * `packages/core/src/side-advantage.test.ts`. What this file adds is the thing
 * a unit test cannot: the measurement run against the real Environment, and a
 * committed report that goes red the moment the number moves.
 *
 * Regenerate the committed artefacts with:
 *   TOKENBRAWL_WRITE_SIDE_ADVANTAGE_REPORT=1 npx vitest run --root packages/env-fighter \
 *     src/side-advantage.test.ts
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WRITE_REPORT = process.env.TOKENBRAWL_WRITE_SIDE_ADVANTAGE_REPORT === '1';

/** One ladder run shared by every case: 600 Matches, ~1s. */
const run: LadderRun = await runSkillLadder();
const matches = ladderSideAdvantageMatches(run);
const summary: SideAdvantageSummary = summariseSideAdvantage({
  matches,
  resamples: SIDE_ADVANTAGE_BOOTSTRAP_RESAMPLES,
  seed: SIDE_ADVANTAGE_BOOTSTRAP_SEED,
});
const coverage = summarisePairingCoverage(matches);
const report: SideAdvantageReport = buildSideAdvantageReport(run, summary, coverage);

describe('the ladder corpus is mirrored end to end (AD-12)', () => {
  it('re-expresses every ladder Match from side 0’s point of view', () => {
    expect(matches).toHaveLength(run.pairings.length * LADDER_SEED_COUNT * 2);
  });

  it('leaves no Match outside a complete mirrored pair', () => {
    expect(summary.unpairedMatches).toBe(0);
    expect(summary.mirroredPairs).toBe(run.pairings.length * LADDER_SEED_COUNT);
  });

  it('scores side 0 as the complement of the stronger bot’s score when it played side 1', () => {
    // One source of truth for who won: the ladder records the stronger bot's
    // score, and side 0's is its complement, never a second derivation from
    // the outcome that could disagree.
    for (const pairing of run.pairings) {
      for (const match of pairing.matches) {
        const reExpressed = matches.find(
          (entry) =>
            entry.seed === match.seed &&
            entry.agentIds[match.strongerAgentIndex] === pairing.stronger &&
            entry.agentIds[match.strongerAgentIndex === 0 ? 1 : 0] === pairing.weaker,
        );
        expect(reExpressed).toBeDefined();
        expect(reExpressed?.side0ScoreBasisPoints).toBe(
          match.strongerAgentIndex === 0
            ? match.scoreBasisPoints
            : WIN_BASIS_POINTS - match.scoreBasisPoints,
        );
      }
    }
  });
});

describe('every ladder pairing clears the rating floor (AC3)', () => {
  it('is rated, not provisional', () => {
    expect(coverage).toHaveLength(run.pairings.length);
    for (const row of coverage) {
      expect(row.matches).toBe(LADDER_SEED_COUNT * 2);
      expect(row.mirroredSeeds).toBe(LADDER_SEED_COUNT);
      expect(row.matchesBySide).toStrictEqual([LADDER_SEED_COUNT, LADDER_SEED_COUNT]);
      expect(row.provisional).toBe(false);
    }
  });
});

describe('the measured side advantage (AC4)', () => {
  it('is a signed number against a side-neutral 5000 basis points', () => {
    expect(NEUTRAL_SIDE_SCORE_BASIS_POINTS).toBe(5000);
    expect(summary.advantageBasisPoints).toBe(
      summary.side0ScoreBasisPoints - NEUTRAL_SIDE_SCORE_BASIS_POINTS,
    );
    expect(Number.isSafeInteger(summary.advantageBasisPoints)).toBe(true);
  });

  it('reproduces exactly across two runs of the whole measurement', async () => {
    const second = await runSkillLadder();
    expect(
      summariseSideAdvantage({
        matches: ladderSideAdvantageMatches(second),
        resamples: SIDE_ADVANTAGE_BOOTSTRAP_RESAMPLES,
        seed: SIDE_ADVANTAGE_BOOTSTRAP_SEED,
      }),
    ).toStrictEqual(summary);
  });

  it('agrees with its own detection rule', () => {
    const excludesNeutral =
      summary.interval.lowerBasisPoints > NEUTRAL_SIDE_SCORE_BASIS_POINTS ||
      summary.interval.upperBasisPoints < NEUTRAL_SIDE_SCORE_BASIS_POINTS;
    expect(summary.detected).toBe(excludesNeutral);
  });

  it('uses its own resampling seed, not the skill gate’s', () => {
    // Reusing the gate's seed would resample this sample along the identical
    // index sequence and correlate two intervals read as independent evidence.
    expect(summary.interval.seed).toBe(SIDE_ADVANTAGE_BOOTSTRAP_SEED);
    expect(summary.interval.resamples).toBe(SIDE_ADVANTAGE_BOOTSTRAP_RESAMPLES);
  });
});

describe('formatSignedBasisPoints', () => {
  it('renders a sign and never leaks a float into the rendering path', () => {
    expect(formatSignedBasisPoints(0)).toBe('+0.0000');
    expect(formatSignedBasisPoints(2500)).toBe('+0.2500');
    expect(formatSignedBasisPoints(-2500)).toBe('-0.2500');
    expect(formatSignedBasisPoints(-10000)).toBe('-1.0000');
  });
});

describe('the committed report (AC4: reported, not merely computed)', () => {
  it('matches a fresh measurement byte for byte', () => {
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const markdown = renderSideAdvantageMarkdown(report);

    if (WRITE_REPORT) {
      writeFileSync(join(REPO_ROOT, SIDE_ADVANTAGE_REPORT_PATH), json, 'utf8');
      writeFileSync(join(REPO_ROOT, SIDE_ADVANTAGE_REPORT_MARKDOWN_PATH), markdown, 'utf8');
    }

    expect(readFileSync(join(REPO_ROOT, SIDE_ADVANTAGE_REPORT_PATH), 'utf8')).toBe(json);
    expect(readFileSync(join(REPO_ROOT, SIDE_ADVANTAGE_REPORT_MARKDOWN_PATH), 'utf8')).toBe(
      markdown,
    );
  });

  it('records the configuration the corpus was played under', () => {
    expect(report.configHash).toBe(run.configHash);
    expect(report.environment).toStrictEqual(run.environment);
    expect(report.seedBase).toBe(run.seedBase);
    expect(report.seedCount).toBe(LADDER_SEED_COUNT);
  });

  it('states the verdict in words a reader can act on', () => {
    const markdown = renderSideAdvantageMarkdown(report);
    expect(markdown).toContain(
      report.detected ? 'A SIDE ADVANTAGE IS DETECTED' : 'no side advantage detected',
    );
    expect(markdown).toContain(formatSignedBasisPoints(report.advantageBasisPoints));
    for (const row of coverage) {
      expect(markdown).toContain(`${row.pairing[0]} vs ${row.pairing[1]}`);
    }
  });

  it('carries the story key in a form the INV-2 float sweep cannot mistake for a literal', () => {
    expect(report.story).toBe('7-1-mirrored-seeds-and-side-swaps');
  });
});
