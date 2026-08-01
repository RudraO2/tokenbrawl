/**
 * The one thing in this repository that may publish a rating table.
 *
 * Story 7-2's first acceptance criterion has two halves. "Every rating carries
 * a bootstrapped confidence interval" is a property of `RatingRow`, whose
 * `interval` is not optional. "**No raw win table is ever published without
 * CIs**" is a property of the *publisher*, and cannot be typed -- so instead
 * there is exactly one publisher, here, and it always emits a CI column.
 * `packages/cli/src/publication-discipline.test.ts` sweeps every committed
 * report for a rating table without one, which covers artefacts written by
 * stories that do not exist yet.
 *
 * Pure: builds a JSON-shaped object and renders Markdown from it. File I/O
 * belongs to the caller, exactly as `make-skill-gate-report.ts` splits it, so
 * the function that produced the committed bytes is the one a test re-runs.
 *
 * Everything numeric in the JSON is an integer in basis points. Rendering
 * decides where the point goes, once, in `formatBasisPoints` -- a report that
 * formatted its own numbers would be a second answer to "what does 0 to 10000
 * mean" and the two would eventually disagree.
 */

import type { Leaderboard, RatingRow, RatingTrack, UnratedAgent } from './ratings';
import { formatBasisPoints } from './statistics';

export interface LeaderboardReportMeta {
  /**
   * The sprint-status key, never the dotted story number: `audit-invariants.sh`
   * reads a digit-dot-digit sequence anywhere under `packages/` as a
   * floating-point literal (INV-2) and does not exempt string contents.
   */
  readonly story: string;
  readonly title: string;
  /** The command or test that regenerates this file. Printed into it. */
  readonly generatedBy: string;
  /** One sentence describing where the Matches came from. */
  readonly corpus: string;
  readonly environment: { readonly id: string; readonly version: string };
  readonly configHash: string;
}

export interface ReportOpponent {
  readonly opponent: string;
  readonly matches: number;
  readonly scoreBasisPoints: number;
}

export interface ReportRatingRow {
  readonly agent: string;
  readonly kind: 'deployment' | 'bot';
  readonly track: RatingTrack;
  readonly matches: number;
  readonly ratingBasisPoints: number;
  readonly ciLowerBasisPoints: number;
  readonly ciUpperBasisPoints: number;
  readonly opponents: readonly ReportOpponent[];
}

export interface ReportPairingCoverage {
  readonly pairing: readonly [string, string];
  readonly matches: number;
  readonly matchesBySide: readonly [number, number];
  readonly mirroredSeeds: number;
  readonly provisional: boolean;
  readonly exclusions: readonly string[];
}

export interface ReportExclusionTotal {
  readonly exclusion: string;
  readonly matches: number;
}

export interface LeaderboardReport {
  readonly story: string;
  readonly title: string;
  readonly generatedBy: string;
  readonly corpus: string;
  readonly environment: { readonly id: string; readonly version: string };
  readonly configHash: string;
  readonly matches: number;
  readonly ratedMatches: number;
  readonly excludedMatches: number;
  /** One entry per distinct reason, so a reader never counts rows by hand. */
  readonly exclusionTotals: readonly ReportExclusionTotal[];
  readonly bootstrap: {
    readonly method: 'percentile';
    readonly resamples: number;
    readonly seed: number;
    readonly confidenceBasisPoints: number;
  };
  readonly mainLeaderboard: readonly ReportRatingRow[];
  readonly reflexTrack: readonly ReportRatingRow[];
  readonly unrated: readonly UnratedAgent[];
  readonly coverage: readonly ReportPairingCoverage[];
}

function reportRow(row: RatingRow): ReportRatingRow {
  return {
    agent: row.agent,
    kind: row.kind,
    track: row.track,
    matches: row.matches,
    ratingBasisPoints: row.ratingBasisPoints,
    ciLowerBasisPoints: row.interval.lowerBasisPoints,
    ciUpperBasisPoints: row.interval.upperBasisPoints,
    opponents: row.opponents.map((opponent) => ({
      opponent: opponent.opponent,
      matches: opponent.matches,
      scoreBasisPoints: opponent.scoreBasisPoints,
    })),
  };
}

/** Every exclusion reason that occurred, with how many Matches it removed. */
function exclusionTotals(leaderboard: Leaderboard): readonly ReportExclusionTotal[] {
  const totals = new Map<string, number>();
  for (const excluded of leaderboard.excludedMatches) {
    // A Match can be excluded for two reasons at once (too few Matches *and*
    // too few mirrored seeds). Counting it under each is what makes the totals
    // answer "how many Matches did this rule remove", which is the question a
    // reader has; they deliberately do not sum to `excludedMatches`.
    for (const exclusion of excluded.exclusions) {
      totals.set(exclusion, (totals.get(exclusion) ?? 0) + 1);
    }
  }
  return [...totals.entries()]
    .map(([exclusion, matches]) => ({ exclusion, matches }))
    .sort((left, right) => (left.exclusion < right.exclusion ? -1 : 1));
}

export function buildLeaderboardReport(
  leaderboard: Leaderboard,
  meta: LeaderboardReportMeta,
): LeaderboardReport {
  return {
    story: meta.story,
    title: meta.title,
    generatedBy: meta.generatedBy,
    corpus: meta.corpus,
    environment: meta.environment,
    configHash: meta.configHash,
    matches: leaderboard.matches,
    ratedMatches: leaderboard.ratedMatches,
    excludedMatches: leaderboard.excludedMatches.length,
    exclusionTotals: exclusionTotals(leaderboard),
    bootstrap: {
      method: 'percentile',
      resamples: leaderboard.bootstrap.resamples,
      seed: leaderboard.bootstrap.seed,
      confidenceBasisPoints: leaderboard.bootstrap.confidenceBasisPoints,
    },
    mainLeaderboard: leaderboard.main.map(reportRow),
    reflexTrack: leaderboard.reflex.map(reportRow),
    unrated: leaderboard.unrated,
    coverage: leaderboard.coverage.map((row) => ({
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
 * The rating table header.
 *
 * The CI column is not optional and not conditional: there is no branch in this
 * file that emits a rating without one, which is the whole mechanism behind
 * "no raw win table is ever published without CIs". The coverage is stated once
 * in the preamble rather than in the header, so the header cannot claim a
 * coverage the intervals were not computed at.
 */
const TABLE_HEADER = '| Agent | Kind | Matches | Opponents | Rating | CI |';
const TABLE_RULE = '| --- | --- | --- | --- | --- | --- |';

function pushTable(lines: string[], rows: readonly ReportRatingRow[], emptyNote: string): void {
  if (rows.length === 0) {
    lines.push(`_${emptyNote}_`);
    return;
  }
  lines.push(TABLE_HEADER);
  lines.push(TABLE_RULE);
  for (const row of rows) {
    lines.push(
      `| ${row.agent} | ${row.kind} | ${String(row.matches)} | ${String(row.opponents.length)} | ${formatBasisPoints(row.ratingBasisPoints)} | ${formatBasisPoints(row.ciLowerBasisPoints)} – ${formatBasisPoints(row.ciUpperBasisPoints)} |`,
    );
  }
}

export function renderLeaderboardMarkdown(report: LeaderboardReport): string {
  const lines: string[] = [];

  lines.push(`# ${report.title}`);
  lines.push('');
  lines.push(`**Generated artefact — do not hand-edit.** Regenerate with \`${report.generatedBy}\`.`);
  lines.push('');
  lines.push(
    'A rating is the Agent’s mean score over its rated Matches — a win is a whole point, a draw',
  );
  lines.push(
    'half of one — with a seeded percentile bootstrap interval beside it. Ratings are comparable',
  );
  lines.push(
    'only within a table, and only as far as the two Agents met comparable opposition, so the',
  );
  lines.push('opponent count and the full per-opponent breakdown are published with every row.');
  lines.push('');
  lines.push(`- Environment: \`${report.environment.id}\` v${report.environment.version}`);
  lines.push(`- Frame-data config hash: \`${report.configHash}\``);
  lines.push(`- Corpus: ${report.corpus}`);
  lines.push(
    `- Matches: ${String(report.matches)} total, ${String(report.ratedMatches)} rated, ${String(report.excludedMatches)} excluded`,
  );
  lines.push(
    `- Confidence interval: seeded percentile bootstrap, ${String(report.bootstrap.resamples)} resamples, seed ${String(report.bootstrap.seed)}, ${formatBasisPoints(report.bootstrap.confidenceBasisPoints)} coverage (AD-5)`,
  );
  lines.push('');

  lines.push('## Main leaderboard');
  lines.push('');
  pushTable(
    lines,
    report.mainLeaderboard,
    'No rated entry on the main leaderboard. Every Deployment needs a Metering Probe result of `reports-reasoning` to appear here (INV-5).',
  );
  lines.push('');

  lines.push('## Reflex Track');
  lines.push('');
  lines.push(
    'Separate by construction, and never merged into the table above (INV-5, AD-11). A Deployment',
  );
  lines.push(
    'lands here when its Metering Probe did not report a separate deliberation count, so its Token',
  );
  lines.push('Bank cannot be debited honestly — its Matches are still played and still published.');
  lines.push('');
  pushTable(lines, report.reflexTrack, 'No Reflex-Track entry in this corpus.');
  lines.push('');

  if (report.unrated.length > 0) {
    lines.push('## Not rated');
    lines.push('');
    // `Entrant`, not `Agent`: the rating tables above start `| Agent | Kind |`
    // and both this renderer's own tests and the committed-report sweep in
    // `packages/cli/src/publication-discipline.test.ts` identify a rating table
    // by that prefix. A table of Agents that carries no rating must not answer
    // to it, or the check that every rating row has an interval would start
    // inspecting rows that have no rating at all.
    lines.push('| Entrant | Kind | Track | Why |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of report.unrated) {
      lines.push(`| ${row.agent} | ${row.kind} | ${row.track} | ${row.reason} |`);
    }
    lines.push('');
  }

  lines.push('## Pairing coverage');
  lines.push('');
  lines.push(
    'A pairing is rated only once it has been played enough, from both sides; below either floor it',
  );
  lines.push('is provisional and contributes to no rating (Story 7-1, AC3).');
  lines.push('');
  lines.push('| Pairing | Matches | On side 0 | Mirrored seeds | Rated |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const row of report.coverage) {
    lines.push(
      `| ${row.pairing[0]} vs ${row.pairing[1]} | ${String(row.matches)} | ${String(row.matchesBySide[0])} / ${String(row.matchesBySide[1])} | ${String(row.mirroredSeeds)} | ${row.provisional ? `provisional (${row.exclusions.join(', ')})` : 'yes'} |`,
    );
  }
  lines.push('');

  if (report.exclusionTotals.length > 0) {
    lines.push('## Excluded Matches');
    lines.push('');
    lines.push(
      'Counted per reason, so a Match excluded twice over appears under both; the column does not sum',
    );
    lines.push('to the total above.');
    lines.push('');
    lines.push('| Reason | Matches |');
    lines.push('| --- | --- |');
    for (const total of report.exclusionTotals) {
      lines.push(`| ${total.exclusion} | ${String(total.matches)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
