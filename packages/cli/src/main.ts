import { secretsFor, type AgentDeps } from './agents';
import { loadRunConfig, tournamentWarnings, type RunConfig } from './config';
import type { CliIo } from './io';
import { outstandingMatches, planMatch, planTournament, type PlannedMatch } from './plan';
import { runPlannedMatches, type RunSummary } from './run';
import { guardSecrets } from './secrets';
import type { FreeTierConfig } from '../../providers/src/free-tier';
import type { HttpFetch, Sleep } from '../../providers/src/http';

/**
 * Argument parsing and dispatch, and nothing else.
 *
 * `main` returns an exit code rather than calling `process.exit`, and never
 * throws for an operator error -- a bad config, a missing key and an unknown
 * flag are all ordinary outcomes of a command line, and each deserves a
 * message and a non-zero code, not a stack trace. `cli.ts` is the only file
 * that turns the code into an exit.
 *
 * The order of operations in `runCommand` is the security-relevant part: the
 * config is loaded, every key is resolved, and the io is **wrapped** before a
 * single Match is planned. Nothing downstream ever holds an unguarded io, so
 * AC3 does not depend on any later call site remembering it.
 */

export const USAGE = `tokenbrawl -- run Tokenbrawl Matches from the command line

  match      --config <path> --seed <n> --agents <idA>,<idB> [--out <dir>]
  tournament --config <path> [--out <dir>]

  --config   path to a JSON run config (required)
  --seed     the seed for a single Match (match only)
  --agents   two comma-separated agent ids from the config (match only)
  --out      output directory override (default: the config's outputDir, else replays/)

Provider keys are read from the environment only, via each Deployment's
"apiKeyEnv" name. They are never read from the config file, never written to
a log, and redacted from anything this command prints.`;

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;

export interface MainDeps {
  readonly fetch?: HttpFetch;
  readonly sleep?: Sleep;
  readonly freeTier?: FreeTierConfig;
}

interface ParsedArgs {
  readonly command: string;
  readonly options: Readonly<Record<string, string>>;
}

class UsageError extends Error {}

/**
 * A minimal `--flag value` parser.
 *
 * No dependency, because there is no argument shape here that earns one, and
 * `apps/web` set the precedent that this repo does not add a runtime package
 * for something it can express in twenty lines (INV-8's dependency discipline
 * points the same way). Unknown flags are an error rather than being ignored:
 * a mistyped `--seeds 4101` that silently ran the wrong thing is worse than a
 * refusal.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new UsageError('No command given.');
  }

  const [command, ...rest] = argv;
  if (command.startsWith('-')) {
    throw new UsageError(`Expected a command before any option, got "${command}".`);
  }

  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      throw new UsageError(`Unexpected argument "${token}".`);
    }
    const name = token.slice(2);
    if (name === '') {
      throw new UsageError('Empty option name ("--").');
    }
    if (name in options) {
      throw new UsageError(`Option --${name} was given twice.`);
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`Option --${name} needs a value.`);
    }
    options[name] = value;
    index += 1;
  }

  return { command, options };
}

function requireOption(options: Readonly<Record<string, string>>, name: string): string {
  const value = options[name];
  if (value === undefined) {
    throw new UsageError(`--${name} is required.`);
  }
  return value;
}

function assertKnownOptions(options: Readonly<Record<string, string>>, allowed: readonly string[]): void {
  for (const name of Object.keys(options)) {
    if (!allowed.includes(name)) {
      throw new UsageError(`Unknown option --${name}. Allowed here: ${allowed.map((a) => `--${a}`).join(', ')}.`);
    }
  }
}

function parseSeed(raw: string): number {
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new UsageError(`--seed must be a whole number >= 0; got "${raw}".`);
  }
  return seed;
}

function parsePair(raw: string): readonly [string, string] {
  const ids = raw.split(',').map((id) => id.trim());
  if (ids.length !== 2 || ids[0] === '' || ids[1] === '') {
    throw new UsageError(`--agents needs exactly two comma-separated ids; got "${raw}".`);
  }
  if (ids[0] === ids[1]) {
    // Not a technical limitation -- the engine would happily run it -- but
    // both sides would carry the same Agent id, `computeMatchId` would fold
    // them together, and the log would be ambiguous about which side a name
    // referred to. Declare the same model twice under two ids instead.
    throw new UsageError(`--agents names "${ids[0]}" on both sides. Declare two distinct agent ids.`);
  }
  return [ids[0], ids[1]];
}

function withOutputOverride(config: RunConfig, out: string | undefined): RunConfig {
  return out === undefined ? config : Object.freeze({ ...config, outputDir: out });
}

function summarise(io: CliIo, label: string, summary: RunSummary): void {
  io.out(
    `${label}: ${String(summary.completed)} run, ${String(summary.skipped)} already committed, ` +
      `${String(summary.planned)} planned.`,
  );
}

async function runCommand(
  parsed: ParsedArgs,
  io: CliIo,
  deps: MainDeps,
  adoptReporter: (guarded: CliIo) => void,
): Promise<number> {
  const isTournament = parsed.command === 'tournament';
  assertKnownOptions(parsed.options, isTournament ? ['config', 'out'] : ['config', 'out', 'seed', 'agents']);

  const loaded = await loadRunConfig(io, requireOption(parsed.options, 'config'));
  const config = withOutputOverride(loaded, parsed.options['out']);

  // Resolved before anything is planned or run: a missing key is a message at
  // second zero rather than after the first pairing has burned quota, and the
  // redaction guard is armed before there is anything to redact.
  const secrets = secretsFor(config, io);
  const guarded = guardSecrets(io, secrets);
  // From here on, even an *unexpected* failure is reported through the guard:
  // `main`'s catch clause reports via whatever this hands it. Errors that can
  // only happen before this line -- a bad config, an unset key -- are the ones
  // that provably carry no key, because `resolveApiKey` names the environment
  // variable and never its value.
  adoptReporter(guarded);

  for (const warning of tournamentWarnings(config)) {
    guarded.err(`warning: ${warning}`);
  }

  const agentDeps: AgentDeps = {
    io: guarded,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.freeTier === undefined ? {} : { freeTier: deps.freeTier }),
    onRateLimit: (signal) => {
      // Story 5.1 reports it and does nothing else. Acting on it -- pacing,
      // parking a Deployment that has hit a daily quota -- is Story 5.2.
      guarded.err(
        `rate limit: ${signal.provider} ${signal.model} -- retry after ${String(signal.retryAfterMs)}ms`,
      );
    },
  };

  const planned: readonly PlannedMatch[] = isTournament
    ? planTournament(config)
    : [planMatch(parseSeed(requireOption(parsed.options, 'seed')), parsePair(requireOption(parsed.options, 'agents')))];

  // Both commands resume. A `match` re-invoked after its log was committed is
  // the same question a tournament asks about each of its Matches, and
  // answering it differently for a plan of one would mean two resume rules.
  const outstanding = await outstandingMatches(planned, guarded, config.outputDir);
  const summary = await runPlannedMatches(outstanding, config, agentDeps, planned.length - outstanding.length);

  summarise(guarded, parsed.command, summary);
  return EXIT_OK;
}

export async function main(argv: readonly string[], io: CliIo, deps: MainDeps = {}): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(USAGE);
    return EXIT_USAGE;
  }

  if (parsed.command === 'help' || parsed.command === '--help') {
    io.out(USAGE);
    return EXIT_OK;
  }

  if (parsed.command !== 'match' && parsed.command !== 'tournament') {
    io.err(`Unknown command "${parsed.command}".`);
    io.err(USAGE);
    return EXIT_USAGE;
  }

  // Upgraded to the redacting wrapper the moment one exists, so a failure
  // deep inside a Match is reported through the same guard the Match's own
  // output went through.
  let reporter: CliIo = io;

  try {
    return await runCommand(parsed, io, deps, (guarded) => {
      reporter = guarded;
    });
  } catch (error) {
    reporter.err(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError) {
      reporter.err(USAGE);
      return EXIT_USAGE;
    }
    return 1;
  }
}
