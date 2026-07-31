import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateSkillGate, type SkillGateVerdict } from '../../core/src/skill-gate';
import { WIN_BASIS_POINTS } from '../../core/src/statistics';
import {
  SKILL_GATE_REPORT_MARKDOWN_PATH,
  SKILL_GATE_REPORT_PATH,
  buildSkillGateReport,
  renderSkillGateMarkdown,
  type SkillGateReport,
} from './testing/make-skill-gate-report';
import {
  AGGRESSIVE_BOT_ID,
  LADDER_BOOTSTRAP_RESAMPLES,
  LADDER_BOOTSTRAP_SEED,
  LADDER_SEED_COUNT,
  RANDOM_BOT_ID,
  SPACING_BOT_ID,
  runSkillLadder,
  type LadderRun,
} from './testing/skill-ladder';

/**
 * Story 2.4 -- the skill separation gate. **The gate run is the test.**
 *
 * This is the project's highest-risk assumption stated as an executable
 * claim: a stronger player beats a weaker one reliably enough that a
 * leaderboard built on this environment measures skill rather than noise.
 * Epics 3, 4, 5 and 7 all sit downstream of it.
 *
 * If this file goes red, the fix is deepening the game -- frame data, the
 * Commitment Window numbers, the bots' reads. It is never lowering a
 * threshold. The three numbers were committed in the story before a single
 * Match was played precisely so that they could not be moved to fit a result,
 * and `scripts/audit-invariants.sh` pins all three so that moving one cannot
 * pass CI quietly.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WRITE_REPORT = process.env.TOKENBRAWL_WRITE_GATE_REPORT === '1';

/**
 * One ladder run shared by every case below: 600 Matches, ~1s. Re-running it
 * per case would be six times the cost for information that cannot differ --
 * the ladder is a pure function of its seeds and the frame data.
 */
const run: LadderRun = await runSkillLadder();
const verdict: SkillGateVerdict = evaluateSkillGate({
  pairings: run.pairings,
  resamples: LADDER_BOOTSTRAP_RESAMPLES,
  seed: LADDER_BOOTSTRAP_SEED,
});
const report: SkillGateReport = buildSkillGateReport(run, verdict);

function pairingFor(stronger: string, weaker: string) {
  const found = verdict.pairings.find(
    (entry) => entry.stronger === stronger && entry.weaker === weaker,
  );
  if (found === undefined) {
    throw new Error(`no pairing ${stronger} vs ${weaker} in the ladder`);
  }
  return found;
}

describe('skill separation gate (FR-3, the gate on E3/E4/E5/E7)', () => {
  it('plays at least 200 Matches per pairing, 100 seeds from both sides (AC1)', () => {
    expect(run.seedCount).toBe(LADDER_SEED_COUNT);
    for (const pairing of verdict.pairings) {
      expect(pairing.matches).toBe(LADDER_SEED_COUNT * 2);
      expect(pairing.matches).toBeGreaterThanOrEqual(verdict.minimumMatchesPerPairing);
    }
  });

  it('plays every seed from both sides as separate Matches with distinct ids (AD-12)', () => {
    for (const pairing of run.pairings) {
      const bySeed = new Map<number, Set<0 | 1>>();
      for (const match of pairing.matches) {
        const sides = bySeed.get(match.seed) ?? new Set<0 | 1>();
        sides.add(match.strongerAgentIndex);
        bySeed.set(match.seed, sides);
      }
      expect(bySeed.size).toBe(LADDER_SEED_COUNT);
      for (const sides of bySeed.values()) {
        expect([...sides].sort()).toStrictEqual([0, 1]);
      }
    }

    const matchIds = run.pairings.flatMap((pairing) => pairing.matches.map((m) => m.matchId));
    expect(new Set(matchIds).size).toBe(matchIds.length);
  });

  it('orders the three bots strictly, with non-overlapping 95% CIs (AC1)', () => {
    expect(verdict.ladder.map((row) => row.agent)).toStrictEqual([
      SPACING_BOT_ID,
      AGGRESSIVE_BOT_ID,
      RANDOM_BOT_ID,
    ]);

    for (let index = 1; index < verdict.ladder.length; index += 1) {
      const above = verdict.ladder[index - 1];
      const below = verdict.ladder[index];
      expect(above.interval.pointEstimateBasisPoints).toBeGreaterThan(
        below.interval.pointEstimateBasisPoints,
      );
      expect(above.interval.lowerBasisPoints).toBeGreaterThan(below.interval.upperBasisPoints);
    }
  });

  it('clears spacing-aware over random at >= 0.6500 (AC2)', () => {
    const pairing = pairingFor(SPACING_BOT_ID, RANDOM_BOT_ID);
    expect(pairing.thresholdBasisPoints).toBe(6500);
    expect(pairing.interval.lowerBasisPoints).toBeGreaterThanOrEqual(6500);
  });

  it('clears spacing-aware over aggressive at >= 0.5500 (AC2)', () => {
    const pairing = pairingFor(SPACING_BOT_ID, AGGRESSIVE_BOT_ID);
    expect(pairing.thresholdBasisPoints).toBe(5500);
    expect(pairing.interval.lowerBasisPoints).toBeGreaterThanOrEqual(5500);
  });

  it('clears aggressive over random at >= 0.5000 (AC2)', () => {
    const pairing = pairingFor(AGGRESSIVE_BOT_ID, RANDOM_BOT_ID);
    expect(pairing.thresholdBasisPoints).toBe(5000);
    expect(pairing.interval.lowerBasisPoints).toBeGreaterThanOrEqual(5000);
  });

  it('passes as a whole, and names every reason if it does not (AC4)', () => {
    // The assertion the story's escalation clause hangs on. `failures` is
    // asserted before `passed` so a red run prints *why* rather than "expected
    // false to be true".
    expect(verdict.failures).toStrictEqual([]);
    expect(verdict.passed).toBe(true);
  });

  it('is not vacuous: the same evaluator fails these Matches against a raised threshold', () => {
    // Proves the thresholds are actually compared against, rather than the
    // gate passing because every pairing trivially clears anything.
    const raised = evaluateSkillGate({
      pairings: run.pairings.map((pairing) => ({ ...pairing, thresholdBasisPoints: WIN_BASIS_POINTS })),
      resamples: LADDER_BOOTSTRAP_RESAMPLES,
      seed: LADDER_BOOTSTRAP_SEED,
    });
    expect(raised.passed).toBe(false);
    expect(raised.failures.length).toBeGreaterThanOrEqual(3);
  });

  it('reproduces the identical ladder from the identical seeds (INV-2)', async () => {
    // 600 Matches is a far wider net for non-determinism than Epic 1's gate
    // cast. A mismatch here is a determinism bug, not flakiness.
    const again = await runSkillLadder();
    expect(again).toStrictEqual(run);
  });

  it('matches the committed report, which records rates, CIs, counts and the config hash (AC3)', () => {
    const jsonPath = join(REPO_ROOT, SKILL_GATE_REPORT_PATH);
    const markdownPath = join(REPO_ROOT, SKILL_GATE_REPORT_MARKDOWN_PATH);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const markdown = `${renderSkillGateMarkdown(report)}\n`;

    if (WRITE_REPORT) {
      writeFileSync(jsonPath, json, 'utf8');
      writeFileSync(markdownPath, markdown, 'utf8');
    }

    // The committed report is a fact about the code at a point in time, the
    // same way Story 1.4's golden Command Log is. Recomputing it here means a
    // frame-data edit that moves a win rate fails loudly instead of leaving a
    // published report quietly describing a game that no longer exists.
    expect(readFileSync(jsonPath, 'utf8')).toBe(json);
    expect(readFileSync(markdownPath, 'utf8')).toBe(markdown);

    const committed = JSON.parse(readFileSync(jsonPath, 'utf8')) as SkillGateReport;
    expect(committed.configHash).toBe(run.configHash);
    expect(committed.totalMatches).toBe(LADDER_SEED_COUNT * 2 * run.pairings.length);
    expect(committed.distinctMatchIds).toBe(committed.totalMatches);
    expect(committed.passed).toBe(true);
    expect(committed.bootstrap.seed).toBe(LADDER_BOOTSTRAP_SEED);
    expect(committed.bootstrap.confidenceBasisPoints).toBe(9500);
  });
});
