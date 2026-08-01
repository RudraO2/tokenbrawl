/**
 * The committed side-advantage report (Story 7.1, AC4).
 *
 * AC4 asks that any side advantage in the Environment be measurable from
 * published results and reported. The Baseline Bot ladder is that corpus: 3
 * pairings x 100 seeds x 2 sides = 600 real Matches that need no provider key,
 * reproduce exactly from their seeds, and already record which side the
 * stronger bot played. Measuring the advantage there measures the *Environment*
 * rather than any Deployment's behaviour, which is what the criterion asks for.
 *
 * Pure builders only -- no file I/O lives here. `side-advantage.test.ts` owns
 * reading the committed report, comparing it against a fresh run, and rewriting
 * it on demand, exactly as `make-skill-gate-report.ts` splits. The function
 * that produced the committed bytes has to be the one the test re-runs, or the
 * artefact drifts into something nobody can reproduce.
 *
 * Regenerate with:
 *   TOKENBRAWL_WRITE_SIDE_ADVANTAGE_REPORT=1 npx vitest run --root packages/env-fighter \
 *     src/side-advantage.test.ts
 */

import type { PairingCoverage } from '../../../core/src/pairing-coverage';
import {
  MINIMUM_MATCHES_PER_PAIRING,
  MINIMUM_MIRRORED_SEEDS_PER_PAIRING,
} from '../../../core/src/pairing-coverage';
import type { SideAdvantageMatch, SideAdvantageSummary } from '../../../core/src/side-advantage';
import { NEUTRAL_SIDE_SCORE_BASIS_POINTS } from '../../../core/src/side-advantage';
import { WIN_BASIS_POINTS } from '../../../core/src/statistics';
import { formatBasisPoints } from './make-skill-gate-report';
import type { LadderRun } from './skill-ladder';

export const SIDE_ADVANTAGE_REPORT_PATH = 'docs/reports/side-advantage.json';
export const SIDE_ADVANTAGE_REPORT_MARKDOWN_PATH = 'docs/reports/side-advantage.md';

/**
 * Its own resampling seed, not the ladder's.
 *
 * Reusing `LADDER_BOOTSTRAP_SEED` would resample this sample along the
 * identical index sequence the skill gate used, correlating two intervals that
 * are read as independent evidence. The same reasoning `skill-gate.ts` applies
 * per row, applied per report.
 */
export const SIDE_ADVANTAGE_BOOTSTRAP_SEED = 20260801;
export const SIDE_ADVANTAGE_BOOTSTRAP_RESAMPLES = 2000;

export interface ReportPairingCoverage {
  readonly pairing: readonly [string, string];
  readonly matches: number;
  readonly matchesBySide: readonly [number, number];
  readonly mirroredSeeds: number;
  readonly provisional: boolean;
  readonly exclusions: readonly string[];
}

export interface SideAdvantageReport {
  /**
   * The sprint-status key, not the dotted story number: `scripts/audit-invariants.sh`
   * reads a digit-dot-digit sequence anywhere in `packages/` as a
   * floating-point literal (INV-2) and does not exempt string contents.
   */
  readonly story: string;
  readonly environment: { readonly id: string; readonly version: string };
  /** The frame-data config the whole corpus was played under. */
  readonly configHash: string;
  readonly seedBase: number;
  readonly seedCount: number;
  readonly matches: number;
  readonly mirroredPairs: number;
  readonly unpairedMatches: number;
  /** Mean side-0 score across mirrored pairs. 5000 is a side-neutral Environment. */
  readonly side0ScoreBasisPoints: number;
  /** Signed: positive favours side 0 (P1), negative favours side 1 (P2). */
  readonly advantageBasisPoints: number;
  readonly ciLowerBasisPoints: number;
  readonly ciUpperBasisPoints: number;
  /** True when the interval excludes 5000 entirely. */
  readonly detected: boolean;
  readonly bootstrap: {
    readonly method: 'percentile';
    readonly resamples: number;
    readonly seed: number;
    readonly confidenceBasisPoints: number;
  };
  readonly ratingFloor: {
    readonly minimumMatchesPerPairing: number;
    readonly minimumMirroredSeedsPerPairing: number;
  };
  readonly coverage: readonly ReportPairingCoverage[];
}

/**
 * The ladder's Matches, re-expressed from side 0's point of view.
 *
 * `LadderMatch.scoreBasisPoints` is scored from the *stronger* bot's point of
 * view, which is the right frame for a skill gate and the wrong one here: the
 * question is what side 0 scored, whoever was standing on it. The complement is
 * taken rather than recomputed from the outcome, so there is one source of
 * truth for who won.
 */
export function ladderSideAdvantageMatches(run: LadderRun): readonly SideAdvantageMatch[] {
  const matches: SideAdvantageMatch[] = [];
  for (const pairing of run.pairings) {
    for (const match of pairing.matches) {
      const strongerOnSide0 = match.strongerAgentIndex === 0;
      matches.push({
        seed: match.seed,
        agentIds: strongerOnSide0
          ? [pairing.stronger, pairing.weaker]
          : [pairing.weaker, pairing.stronger],
        side0ScoreBasisPoints: strongerOnSide0
          ? match.scoreBasisPoints
          : WIN_BASIS_POINTS - match.scoreBasisPoints,
      });
    }
  }
  return matches;
}

export function buildSideAdvantageReport(
  run: LadderRun,
  summary: SideAdvantageSummary,
  coverage: readonly PairingCoverage[],
): SideAdvantageReport {
  return {
    story: '7-1-mirrored-seeds-and-side-swaps',
    environment: run.environment,
    configHash: run.configHash,
    seedBase: run.seedBase,
    seedCount: run.seedCount,
    matches: summary.matches,
    mirroredPairs: summary.mirroredPairs,
    unpairedMatches: summary.unpairedMatches,
    side0ScoreBasisPoints: summary.side0ScoreBasisPoints,
    advantageBasisPoints: summary.advantageBasisPoints,
    ciLowerBasisPoints: summary.interval.lowerBasisPoints,
    ciUpperBasisPoints: summary.interval.upperBasisPoints,
    detected: summary.detected,
    bootstrap: {
      method: 'percentile',
      resamples: summary.interval.resamples,
      seed: summary.interval.seed,
      confidenceBasisPoints: summary.interval.confidenceBasisPoints,
    },
    ratingFloor: {
      minimumMatchesPerPairing: MINIMUM_MATCHES_PER_PAIRING,
      minimumMirroredSeedsPerPairing: MINIMUM_MIRRORED_SEEDS_PER_PAIRING,
    },
    coverage: coverage.map((row) => ({
      pairing: row.pairing,
      matches: row.matches,
      matchesBySide: row.matchesBySide,
      mirroredSeeds: row.mirroredSeeds,
      provisional: row.provisional,
      exclusions: row.exclusions,
    })),
  };
}

/**
 * A signed basis-point figure, by integer arithmetic only.
 *
 * `formatBasisPoints` is unsigned by construction (it floors, which for a
 * negative value carries the sign into the fractional half and renders
 * nonsense). The advantage is the one number in this report that can be
 * negative, so the sign is split off before formatting.
 */
export function formatSignedBasisPoints(basisPoints: number): string {
  const sign = basisPoints < 0 ? '-' : '+';
  return `${sign}${formatBasisPoints(Math.abs(basisPoints))}`;
}

export function renderSideAdvantageMarkdown(report: SideAdvantageReport): string {
  const lines: string[] = [];

  lines.push('# Side advantage');
  lines.push('');
  lines.push(
    '**Generated artefact — do not hand-edit.** `packages/env-fighter/src/side-advantage.test.ts`',
  );
  lines.push(
    'recomputes this file from a fresh ladder run on every `npm test` and fails if it drifts.',
  );
  lines.push('');
  lines.push(
    `Verdict: **${report.detected ? 'A SIDE ADVANTAGE IS DETECTED' : 'no side advantage detected'}**`,
  );
  lines.push('');
  lines.push(
    `Side 0 (P1) scores ${formatBasisPoints(report.side0ScoreBasisPoints)} across ${report.mirroredPairs} mirrored pairs, an advantage of **${formatSignedBasisPoints(report.advantageBasisPoints)}** against the side-neutral ${formatBasisPoints(NEUTRAL_SIDE_SCORE_BASIS_POINTS)}.`,
  );
  lines.push(
    `The ${formatBasisPoints(report.bootstrap.confidenceBasisPoints)} interval is ${formatBasisPoints(report.ciLowerBasisPoints)} – ${formatBasisPoints(report.ciUpperBasisPoints)}, which ${report.detected ? 'excludes' : 'contains'} ${formatBasisPoints(NEUTRAL_SIDE_SCORE_BASIS_POINTS)}.`,
  );
  lines.push('');
  lines.push('## How this is measured');
  lines.push('');
  lines.push(
    'Within one mirrored pair — the same two Agents, the same seed, swapped — each Agent',
  );
  lines.push(
    'plays each side exactly once, so skill cancels and what is left is the side. The pair',
  );
  lines.push(
    'scores the mean of its two Matches from side 0’s point of view; a side-neutral',
  );
  // Rendered from the constant, never written out: a decimal literal in a
  // shipped-adjacent file under packages/ trips the INV-2 float sweep, which
  // does not exempt string contents.
  lines.push(
    `Environment averages exactly ${formatBasisPoints(NEUTRAL_SIDE_SCORE_BASIS_POINTS)} over those pairs.`,
  );
  lines.push('');
  lines.push(`- Environment: \`${report.environment.id}\` v${report.environment.version}`);
  lines.push(`- Frame-data config hash: \`${report.configHash}\``);
  lines.push(
    `- Corpus: the Baseline Bot ladder — ${report.matches} Matches over ${report.seedCount} seeds from seed base ${report.seedBase}, every seed played from both sides (AD-12)`,
  );
  lines.push(`- Matches in no complete mirrored pair, and therefore excluded: ${report.unpairedMatches}`);
  lines.push(
    `- Confidence interval: seeded percentile bootstrap over *pairs*, ${report.bootstrap.resamples} resamples, seed ${report.bootstrap.seed} (AD-5)`,
  );
  lines.push('');
  lines.push('## Pairing coverage');
  lines.push('');
  lines.push(
    `A pairing is rated only at ${report.ratingFloor.minimumMatchesPerPairing} Matches and ${report.ratingFloor.minimumMirroredSeedsPerPairing} seeds played from both sides; below either it is provisional (Story 7-1, AC3).`,
  );
  lines.push('');
  lines.push('| Pairing | Matches | On side 0 | Mirrored seeds | Rated |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const row of report.coverage) {
    lines.push(
      `| ${row.pairing[0]} vs ${row.pairing[1]} | ${row.matches} | ${row.matchesBySide[0]} / ${row.matchesBySide[1]} | ${row.mirroredSeeds} | ${row.provisional ? `provisional (${row.exclusions.join(', ')})` : 'yes'} |`,
    );
  }
  lines.push('');

  return lines.join('\n');
}
