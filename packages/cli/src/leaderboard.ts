import type { AgentIdentity, CommandLog } from '@tokenbrawl/contracts';
import { computeBehaviouralMetrics } from '../../core/src/behavioural-metrics';
import { validateCommandLog } from '../../core/src/command-log';
import { computeLeaderboard, type LeaderboardMatch, type RatingTrack } from '../../core/src/ratings';
import {
  buildLeaderboardReport,
  renderLeaderboardMarkdown,
  type LeaderboardReport,
} from '../../core/src/ratings-report';
import { partitionByTrack } from '../../providers/src/track';
import type { CliIo } from './io';
import { CLI_ENVIRONMENT_ID, CLI_ENVIRONMENT_VERSION, cliConfigHash, joinPath } from './plan';

/**
 * Leaderboard generation (Story 7-2): the committed Command Logs in, two
 * published artefacts out.
 *
 * This package is where the three rules that decide a rating finally meet,
 * because it is the only one allowed to import all of them. `packages/core`
 * owns the arithmetic and may not import `packages/providers` (AD-1), so the
 * main/Reflex classification is built *here* -- by calling `partitionByTrack`,
 * never by re-deriving it. The 3.4 ledger is explicit that a results generator
 * filtering entries itself re-opens the silent-omission defect that function
 * exists to close.
 *
 * The output path is not free either. Story 5.3's workflow stages
 * `apps/web/public/replays docs/reports` and commits whatever changed there, so
 * an artefact written anywhere else is one no segment ever commits -- a silent,
 * permanent failure with a green run every night.
 */

const LOG_SUFFIX = '.command-log.json';

export const LEADERBOARD_REPORT_DIR = 'docs/reports';
export const LEADERBOARD_REPORT_NAME = 'leaderboard.json';
export const LEADERBOARD_REPORT_MARKDOWN_NAME = 'leaderboard.md';

/**
 * Its own resampling seed, fixed here rather than taken from a clock or a run
 * id: a published interval that moved every night for no reason nobody could
 * reproduce would be worse than no interval (AD-5).
 */
export const LEADERBOARD_BOOTSTRAP_SEED = 20260802;
export const LEADERBOARD_BOOTSTRAP_RESAMPLES = 2000;

export interface LoadedCorpus {
  readonly matches: readonly LeaderboardMatch[];
  /**
   * The logs `matches` was projected from, in the same order.
   *
   * Kept rather than discarded because a rating needs only the outcome while
   * Story 7-3's behavioural metrics need the Decisions -- and reading the
   * directory twice would let the two halves of one published row describe two
   * different sets of files.
   */
  readonly logs: readonly CommandLog[];
  readonly identities: readonly AgentIdentity[];
  /** Files that were not a readable, valid Command Log. Reported, never fatal. */
  readonly unreadable: readonly string[];
  /**
   * Logs played under a different frame-data configuration than this CLI
   * builds. Excluded from the ratings: two Matches under different `configHash`
   * es are not comparable, and AD-8 makes that hash the statement of it.
   */
  readonly staleConfig: readonly string[];
}

export interface LeaderboardCommandResult {
  readonly report: LeaderboardReport;
  readonly corpus: LoadedCorpus;
  readonly written: readonly string[];
}

/**
 * Read every Command Log in `logDir`.
 *
 * A file that does not parse, does not validate, or names a schema version this
 * build does not implement is skipped and counted -- never rated, never fatal.
 * AD-3 requires the refusal; making it fatal would let one truncated file stop
 * a whole board from being published, and a half-written log is exactly what a
 * segment killed mid-write leaves behind.
 */
export async function loadCorpus(io: CliIo, logDir: string): Promise<LoadedCorpus> {
  const names = [...(await io.listFiles(logDir))].filter((name) => name.endsWith(LOG_SUFFIX)).sort();

  const matches: LeaderboardMatch[] = [];
  const logs: CommandLog[] = [];
  const identities: AgentIdentity[] = [];
  const unreadable: string[] = [];
  const staleConfig: string[] = [];
  const expectedConfigHash = cliConfigHash();

  for (const name of names) {
    let log;
    try {
      log = validateCommandLog(JSON.parse(await io.readFile(joinPath(logDir, name))));
    } catch {
      unreadable.push(name);
      continue;
    }

    // Environment version as well as config hash. `configHash` covers the
    // frame data, not the code that reads it, so a version bump is the only
    // statement a log carries that the engine itself changed -- and two
    // Matches played by two engines are not comparable however identical their
    // configuration was.
    if (
      log.configHash !== expectedConfigHash ||
      log.environment.id !== CLI_ENVIRONMENT_ID ||
      log.environment.version !== CLI_ENVIRONMENT_VERSION
    ) {
      staleConfig.push(name);
      continue;
    }

    matches.push({
      matchId: log.matchId,
      seed: log.seed,
      agents: [log.agents[0], log.agents[1]],
      outcome: log.result.outcome,
    });
    logs.push(log);
    identities.push(log.agents[0], log.agents[1]);
  }

  return {
    matches: Object.freeze(matches),
    logs: Object.freeze(logs),
    identities: Object.freeze(identities),
    unreadable: Object.freeze(unreadable),
    staleConfig: Object.freeze(staleConfig),
  };
}

/**
 * The main/Reflex classification for every Agent in the corpus.
 *
 * `partitionByTrack` is the only place that rule is decided (INV-5). One
 * identity per id is passed to it -- the corpus holds one per Match -- and the
 * *most restrictive* one wins: an Agent that appears once without a passing
 * Metering Probe is Reflex Track for the whole corpus, because "it was probed
 * on some nights" is not a thing a leaderboard can act on.
 */
export function tracksFor(identities: readonly AgentIdentity[]): ReadonlyMap<string, RatingTrack> {
  // Asked of `partitionByTrack` rather than answered here, one identity at a
  // time: the question "would this entry be Reflex Track" has exactly one
  // implementation in this repo and this is not it.
  const isReflex = (identity: AgentIdentity): boolean =>
    partitionByTrack([identity]).reflexTrack.length > 0;

  const byId = new Map<string, AgentIdentity>();
  for (const identity of identities) {
    const chosen = byId.get(identity.id);
    if (chosen === undefined || (isReflex(identity) && !isReflex(chosen))) {
      byId.set(identity.id, identity);
    }
  }

  const partition = partitionByTrack([...byId.values()]);
  const tracks = new Map<string, RatingTrack>();
  for (const entry of partition.mainLeaderboard) {
    tracks.set(entry.id, 'main');
  }
  for (const entry of partition.reflexTrack) {
    tracks.set(entry.id, 'reflex');
  }
  return tracks;
}

function corpusSentence(corpus: LoadedCorpus, logDir: string): string {
  const logs = corpus.matches.length;
  const parts = [
    `${String(logs)} committed Command Log${logs === 1 ? '' : 's'} from \`${logDir}\``,
  ];
  if (corpus.staleConfig.length > 0) {
    parts.push(
      `${String(corpus.staleConfig.length)} played under a different frame-data config hash and excluded (AD-8)`,
    );
  }
  if (corpus.unreadable.length > 0) {
    parts.push(`${String(corpus.unreadable.length)} unreadable and skipped`);
  }
  return parts.join('; ');
}

/**
 * Compute the leaderboard from `logDir` and write both artefacts into
 * `reportDir`.
 *
 * Always writes, including when the corpus rates nothing: a board that stops
 * being republished looks exactly like a board nobody has looked at, and the
 * "no rated entry" table states the situation the reader is actually in.
 */
export async function generateLeaderboard(
  io: CliIo,
  logDir: string,
  reportDir: string = LEADERBOARD_REPORT_DIR,
): Promise<LeaderboardCommandResult> {
  const corpus = await loadCorpus(io, logDir);

  // Refusing to publish nothing *over something*.
  //
  // An empty corpus is an ordinary first run and publishes an empty board
  // happily. An empty corpus when a board already exists is not ordinary: it
  // means this invocation read the wrong directory -- a mistyped `--out`, a
  // config whose `outputDir` moved, a workflow running from the wrong working
  // directory -- and overwriting real published ratings with a blank table
  // would be committed by the next step and look exactly like a tournament
  // that had produced nothing.
  if (corpus.matches.length === 0) {
    const existing = await io
      .readFile(joinPath(reportDir, LEADERBOARD_REPORT_NAME))
      .then(() => true)
      .catch(() => false);
    if (existing) {
      throw new Error(
        `No Command Log found in "${logDir}", but ${joinPath(reportDir, LEADERBOARD_REPORT_NAME)} already exists. Refusing to overwrite a published leaderboard with an empty one -- check the log directory.`,
      );
    }
  }

  const leaderboard = computeLeaderboard({
    matches: corpus.matches,
    tracks: tracksFor(corpus.identities),
    resamples: LEADERBOARD_BOOTSTRAP_RESAMPLES,
    seed: LEADERBOARD_BOOTSTRAP_SEED,
  });

  // Behaviour over the *rated* Matches only, so every figure in the "how the
  // tokens were spent" table describes the same Matches as the rating printed
  // beside it. It also inherits AD-11 without a second check: a BYOK Match is
  // never rated, so it never reaches these numbers either, and a visitor
  // cannot move a published parse-failure rate from their own browser.
  const rated = new Set(leaderboard.ratedMatchIds);
  const behaviour = computeBehaviouralMetrics(
    corpus.logs.filter((log) => rated.has(log.matchId)),
  );

  const report = buildLeaderboardReport(
    leaderboard,
    {
      story: '7-3-behavioural-metrics',
      title: 'Tokenbrawl leaderboard',
      generatedBy: 'tokenbrawl leaderboard --config configs/tournament.config.json',
      corpus: corpusSentence(corpus, logDir),
      environment: { id: CLI_ENVIRONMENT_ID, version: CLI_ENVIRONMENT_VERSION },
      configHash: cliConfigHash(),
    },
    behaviour,
  );

  const jsonPath = joinPath(reportDir, LEADERBOARD_REPORT_NAME);
  const markdownPath = joinPath(reportDir, LEADERBOARD_REPORT_MARKDOWN_NAME);

  await io.ensureDir(reportDir);
  await io.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await io.writeFile(markdownPath, renderLeaderboardMarkdown(report));

  return { report, corpus, written: Object.freeze([jsonPath, markdownPath]) };
}
