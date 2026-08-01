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

import { unreportedBehaviour, type AgentBehaviour } from './behavioural-metrics';
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

/** One Agent's behaviour, tagged with the table its rating row sits in. */
export interface ReportBehaviourRow extends AgentBehaviour {
  readonly track: RatingTrack;
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
  /**
   * Story 7-3. One row per rated Agent, in the order the tables print them, so
   * a reader can read across from a rating to how it was earned. An Agent no
   * log covers gets an all-not-reported row rather than being absent -- the
   * silence is the finding.
   */
  readonly behaviour: readonly ReportBehaviourRow[];
  /**
   * Story 7-3, AC2: **if frontier models lose to the scripted bot, that is the
   * headline.** `null` when no Baseline Bot outranks a Deployment; otherwise the
   * sentence rendered above both tables, in bold, before anything else.
   */
  readonly headline: string | null;
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

/**
 * One behaviour row per rated Agent, in table order.
 *
 * Keyed to the rating rows rather than to the corpus, for two reasons. A row in
 * a table with no behaviour beside it reads as an omission, and an Agent that
 * has behaviour but no rating already has an `unrated` entry stating why -- a
 * second row of "not reported" beside it would say less, not more.
 *
 * An Agent with no measurements at all is `unreportedBehaviour`, never a row of
 * zeroes: the Baseline Bot ladder is rated from Match outcomes with no Command
 * Log behind it, and "this ladder measured no tokens" is a different statement
 * from "these bots spent none" (INV-5).
 */
function behaviourRows(
  leaderboard: Leaderboard,
  behaviour: readonly AgentBehaviour[],
): readonly ReportBehaviourRow[] {
  const byAgent = new Map(behaviour.map((row) => [row.agent, row]));
  return [...leaderboard.main, ...leaderboard.reflex].map((row) => ({
    ...(byAgent.get(row.agent) ?? unreportedBehaviour(row.agent, row.kind)),
    track: row.track,
  }));
}

/**
 * AC2, computed from the rows rather than remembered in prose.
 *
 * Nothing in this pipeline filters on `kind` -- a Baseline Bot is rated by the
 * same code as a Deployment and lands in the same table -- so "not hidden, not
 * filtered" is already structural. This is the "displayed plainly" half: when a
 * scripted bot outranks a Deployment, the report leads with it.
 *
 * Compared within a table only. A main-board rating and a Reflex-Track rating
 * are not comparable (INV-5), and a headline that crossed the two would be
 * making exactly the claim that separation exists to prevent.
 */
function headlineFor(leaderboard: Leaderboard): string | null {
  const sentences: string[] = [];

  for (const table of [leaderboard.main, leaderboard.reflex]) {
    const deployments = table.filter((row) => row.kind === 'deployment');
    if (deployments.length === 0) {
      continue;
    }
    for (const bot of table.filter((row) => row.kind === 'bot')) {
      const beaten = deployments.filter(
        (row) => row.ratingBasisPoints < bot.ratingBasisPoints,
      ).length;
      if (beaten === 0) {
        continue;
      }
      sentences.push(
        `The scripted Baseline Bot \`${bot.agent}\` outranks ${String(beaten)} of ${String(deployments.length)} Deployment${deployments.length === 1 ? '' : 's'} in the ${table === leaderboard.main ? 'main leaderboard' : 'Reflex Track'} (${formatBasisPoints(bot.ratingBasisPoints)}).`,
      );
    }
  }

  return sentences.length === 0 ? null : sentences.join(' ');
}

export function buildLeaderboardReport(
  leaderboard: Leaderboard,
  meta: LeaderboardReportMeta,
  behaviour: readonly AgentBehaviour[] = [],
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
    behaviour: behaviourRows(leaderboard, behaviour),
    headline: headlineFor(leaderboard),
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

/**
 * How a not-reported quantity is written down, in words, exactly once.
 *
 * INV-5 in three characters more than a zero would take: a provider that never
 * reported a number and a provider that reported zero are different findings,
 * and the reader has to be able to tell them apart at a glance.
 * `packages/cli/src/publication-discipline.test.ts` sweeps the committed
 * artefacts for this exact string, so it is a shared constant rather than a
 * literal repeated down the file.
 */
export const NOT_REPORTED = 'not reported';

function rateCell(basisPoints: number | null): string {
  return basisPoints === null ? NOT_REPORTED : formatBasisPoints(basisPoints);
}

function countCell(value: number | null): string {
  return value === null ? NOT_REPORTED : String(value);
}

/**
 * A failure rate with the counts it came from in brackets, so a reader never
 * has to take a rate on trust -- `0.5000 (1 of 2)` is checkable and `0.5000`
 * alone is not. A corpus that observed no Decision Point at all has no rate to
 * publish and says so rather than printing a flattering zero.
 */
function failureCell(basisPoints: number | null, failures: number, decisions: number): string {
  if (basisPoints === null) {
    return NOT_REPORTED;
  }
  return `${formatBasisPoints(basisPoints)} (${String(failures)} of ${String(decisions)})`;
}

const BEHAVIOUR_HEADER =
  // `Entrant`, not `Agent`, for the same reason the "Not rated" table below
  // uses it: a rating table in this repo is identified by its `| Agent | Kind |`
  // prefix, both by this renderer's own tests and by the committed-report
  // sweep. A table carrying no rating must not answer to that prefix, or the
  // check that every rating row has an interval starts inspecting rows that
  // have no rating at all.
  '| Entrant | Kind | Track | Tokens / Match | Reasoning share | Parse failures | Rate-limited | Bank exhausted |';
const BEHAVIOUR_RULE = '| --- | --- | --- | --- | --- | --- | --- | --- |';

/**
 * The behavioural section.
 *
 * Deliberately carries no confidence interval and deliberately uses none of the
 * column words `publication-discipline.test.ts` guards (`rating`, `win rate`,
 * `score`, `strength`). A bootstrap over a token count would be a different
 * statistic answering a question nobody asked; inventing one so a header check
 * passes would be the check writing the report.
 *
 * The framing of the parse-failure column is fixed prose and is tested as such
 * (Story 7-3, AC4). It is a measurement of how a model behaved under a strict
 * grammar, not a defect rate with a number somebody is meant to drive down --
 * and a later story that turns it into one goes red rather than shipping.
 */
function pushBehaviour(lines: string[], report: LeaderboardReport): void {
  lines.push('## How the tokens were spent');
  lines.push('');
  lines.push(
    'Behaviour, not skill. These figures come from the same Matches as the ratings above and',
  );
  lines.push(
    'say how each entrant played rather than how often it won — a benchmark that published only a',
  );
  lines.push('win rate would be hiding most of what it measured.');
  lines.push('');
  lines.push(
    `- **Parse failures** count every Decision Point that fell back to \`stand\`. This is a *measurement* of how`,
  );
  lines.push(
    '  a model behaves under a strict, published Action grammar that is identical for every entrant. It is',
  );
  lines.push(
    '  not a fault to be driven down, and no entrant is penalised, filtered or footnoted for having one.',
  );
  lines.push(
    '- **Rate-limited** is the part of that column the provider refused rather than the model fumbled,',
  );
  lines.push(
    '  recognised from the refusal body the log kept verbatim. The two are published side by side because a',
  );
  lines.push(
    '  Command Log cannot tell them apart on its own, and reporting only the total would overstate the model.',
  );
  lines.push(
    `- **${NOT_REPORTED}** means exactly that: the provider never reported the quantity. It is never written as a`,
  );
  lines.push(
    '  zero, because "did not say" and "said none" are different findings and INV-5 turns on the difference.',
  );
  lines.push('');

  if (report.behaviour.length === 0) {
    lines.push(`_No rated entrant, so nothing to report behaviour for._`);
    lines.push('');
    return;
  }

  lines.push(BEHAVIOUR_HEADER);
  lines.push(BEHAVIOUR_RULE);
  for (const row of report.behaviour) {
    lines.push(
      `| ${row.agent} | ${row.kind} | ${row.track} | ${countCell(row.tokensPerMatch)} | ${rateCell(row.reasoningShareBasisPoints)} | ${failureCell(row.parseFailureRateBasisPoints, row.parseFailures, row.decisions)} | ${failureCell(row.rateLimitedRateBasisPoints, row.rateLimited, row.decisions)} | ${rateCell(row.bankExhaustionRateBasisPoints)} |`,
    );
  }
  lines.push('');
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

  // AC2, above both tables and before anything a reader could stop short of.
  // A Deployment beaten by a scripted bot is not a caveat at the bottom of the
  // page; it is the result.
  if (report.headline !== null) {
    lines.push(`**${report.headline}**`);
    lines.push('');
    lines.push(
      'That is published as the headline rather than as a footnote. Nothing here filters, hides or',
    );
    lines.push('annotates a Deployment for losing to the Baseline Bot ladder.');
    lines.push('');
  }

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

  pushBehaviour(lines, report);

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
