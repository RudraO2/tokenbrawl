/**
 * The committed skill-separation gate report (Story 2.4, AC3).
 *
 * Pure builders only -- no file I/O lives here. `skill-gate.test.ts` owns
 * reading the committed report, comparing it against a fresh run, and
 * rewriting it on demand, for the same reason `make-determinism-fixture.ts`
 * splits that way: the function that produced the committed bytes has to be
 * the one the test re-runs, or the artefact drifts into something nobody can
 * reproduce.
 *
 * Regenerate with:
 *   TOKENBRAWL_WRITE_GATE_REPORT=1 npx vitest run --root packages/env-fighter \
 *     src/skill-gate.test.ts
 */

import type { SkillGateVerdict } from '../../../core/src/skill-gate';
import { formatBasisPoints } from '../../../core/src/statistics';
import type { LadderRun } from './skill-ladder';
import { LADDER_BOOTSTRAP_RESAMPLES, LADDER_BOOTSTRAP_SEED } from './skill-ladder';

export const SKILL_GATE_REPORT_PATH = 'docs/reports/skill-separation-gate.json';
export const SKILL_GATE_REPORT_MARKDOWN_PATH = 'docs/reports/skill-separation-gate.md';

/**
 * Story 8.5's report. AD-13: it sits alongside the v1 report above, computed
 * from the identical ladder run, and never replaces it.
 */
export const SKILL_GATE_V2_REPORT_PATH = 'docs/reports/skill-separation-gate-v2.json';
export const SKILL_GATE_V2_REPORT_MARKDOWN_PATH = 'docs/reports/skill-separation-gate-v2.md';

export interface ReportPairing {
  readonly stronger: string;
  readonly weaker: string;
  readonly matches: number;
  readonly koMatches: number;
  readonly thresholdBasisPoints: number;
  readonly winRateBasisPoints: number;
  readonly ciLowerBasisPoints: number;
  readonly ciUpperBasisPoints: number;
  readonly meetsThreshold: boolean;
}

export interface ReportLadderRow {
  readonly agent: string;
  readonly matches: number;
  readonly winRateBasisPoints: number;
  readonly ciLowerBasisPoints: number;
  readonly ciUpperBasisPoints: number;
}

export interface SkillGateReport {
  /**
   * The sprint-status key, not the dotted story number: `scripts/audit-invariants.sh`
   * reads a digit-dot-digit sequence anywhere in `packages/` as a
   * floating-point literal (INV-2) and does not exempt string contents.
   */
  readonly story: string;
  readonly passed: boolean;
  readonly environment: { readonly id: string; readonly version: string };
  /** The frame-data config the whole ladder was played under (AC3). */
  readonly configHash: string;
  readonly seedBase: number;
  readonly seedCount: number;
  readonly totalMatches: number;
  /** AD-12: every Match is its own Match, side swaps included. */
  readonly distinctMatchIds: number;
  readonly bootstrap: {
    readonly method: 'percentile';
    readonly resamples: number;
    readonly seed: number;
    readonly confidenceBasisPoints: number;
  };
  readonly pairings: readonly ReportPairing[];
  readonly ladder: readonly ReportLadderRow[];
  readonly failures: readonly string[];
}

export function buildSkillGateReport(
  run: LadderRun,
  verdict: SkillGateVerdict,
  storyId: string = '2-4-skill-separation-gate',
): SkillGateReport {
  const koByPairing = new Map<string, number>();
  const matchIds = new Set<string>();
  let totalMatches = 0;

  for (const pairing of run.pairings) {
    let kos = 0;
    for (const match of pairing.matches) {
      matchIds.add(match.matchId);
      totalMatches += 1;
      if (match.endReason === 'ko') {
        kos += 1;
      }
    }
    koByPairing.set(`${pairing.stronger}|${pairing.weaker}`, kos);
  }

  const firstInterval = verdict.pairings[0]?.interval;

  return {
    story: storyId,
    passed: verdict.passed,
    environment: run.environment,
    configHash: run.configHash,
    seedBase: run.seedBase,
    seedCount: run.seedCount,
    totalMatches,
    distinctMatchIds: matchIds.size,
    bootstrap: {
      method: 'percentile',
      resamples: LADDER_BOOTSTRAP_RESAMPLES,
      seed: LADDER_BOOTSTRAP_SEED,
      confidenceBasisPoints: firstInterval?.confidenceBasisPoints ?? 0,
    },
    pairings: verdict.pairings.map((pairing) => ({
      stronger: pairing.stronger,
      weaker: pairing.weaker,
      matches: pairing.matches,
      koMatches: koByPairing.get(`${pairing.stronger}|${pairing.weaker}`) ?? 0,
      thresholdBasisPoints: pairing.thresholdBasisPoints,
      winRateBasisPoints: pairing.interval.pointEstimateBasisPoints,
      ciLowerBasisPoints: pairing.interval.lowerBasisPoints,
      ciUpperBasisPoints: pairing.interval.upperBasisPoints,
      meetsThreshold: pairing.meetsThreshold,
    })),
    ladder: verdict.ladder.map((row) => ({
      agent: row.agent,
      matches: row.matches,
      winRateBasisPoints: row.interval.pointEstimateBasisPoints,
      ciLowerBasisPoints: row.interval.lowerBasisPoints,
      ciUpperBasisPoints: row.interval.upperBasisPoints,
    })),
    failures: verdict.failures,
  };
}

/**
 * Basis points as a decimal string, by integer arithmetic only.
 *
 * `(6500 / 10000).toFixed(4)` would be the obvious way and is banned: it puts
 * a float in the rendering path of a number the gate is judged on, and
 * `toFixed` rounds. Splitting the integer and fractional halves keeps the
 * rendered text exactly the value that was compared.
 *
 * The implementation moved to `packages/core/src/statistics.ts` in Story 7-2,
 * which gave the repo a second family of committed reports: two copies of "how
 * a rate is written down" is how two artefacts start rendering one number two
 * ways. Re-exported rather than re-imported at every call site so this module's
 * public surface is unchanged, and the byte-comparison tests over both
 * committed reports prove the move changed no output.
 */
export { formatBasisPoints };

export function renderSkillGateMarkdown(report: SkillGateReport): string {
  const lines: string[] = [];

  lines.push('# Skill separation gate');
  lines.push('');
  lines.push(
    '**Generated artefact — do not hand-edit.** `packages/env-fighter/src/skill-gate.test.ts`',
  );
  lines.push(
    'recomputes this file from a fresh ladder run on every `npm test` and fails if it drifts.',
  );
  lines.push('');
  lines.push(`Result: **${report.passed ? 'PASS' : 'FAIL'}**`);
  lines.push('');
  lines.push(`- Environment: \`${report.environment.id}\` v${report.environment.version}`);
  lines.push(`- Frame-data config hash: \`${report.configHash}\``);
  lines.push(
    `- Matches: ${report.totalMatches} across ${report.pairings.length} pairings (${report.seedCount} seeds x 2 side swaps each, AD-12)`,
  );
  lines.push(`- Distinct match ids: ${report.distinctMatchIds}`);
  lines.push(
    `- Confidence intervals: seeded percentile bootstrap, ${report.bootstrap.resamples} resamples, seed ${report.bootstrap.seed}, ${formatBasisPoints(report.bootstrap.confidenceBasisPoints)} coverage (AD-5)`,
  );
  lines.push('');
  lines.push('## Pairings');
  lines.push('');
  lines.push('| Stronger | Weaker | Matches | KOs | Win rate | 95% CI | Threshold | Met |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const pairing of report.pairings) {
    lines.push(
      `| ${pairing.stronger} | ${pairing.weaker} | ${pairing.matches} | ${pairing.koMatches} | ${formatBasisPoints(pairing.winRateBasisPoints)} | ${formatBasisPoints(pairing.ciLowerBasisPoints)} – ${formatBasisPoints(pairing.ciUpperBasisPoints)} | >= ${formatBasisPoints(pairing.thresholdBasisPoints)} | ${pairing.meetsThreshold ? 'yes' : 'NO'} |`,
    );
  }
  lines.push('');
  lines.push('## Ladder');
  lines.push('');
  lines.push('| Agent | Matches | Win rate | 95% CI |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of report.ladder) {
    lines.push(
      `| ${row.agent} | ${row.matches} | ${formatBasisPoints(row.winRateBasisPoints)} | ${formatBasisPoints(row.ciLowerBasisPoints)} – ${formatBasisPoints(row.ciUpperBasisPoints)} |`,
    );
  }
  lines.push('');
  if (report.failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const failure of report.failures) {
      lines.push(`- ${failure}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
