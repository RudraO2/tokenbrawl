import { computeConfigHash, computeMatchId, validateCommandLog } from '../../core/src/command-log';
import { DEFAULT_FIGHTER_CONFIG } from '../../env-fighter/src/config';
import { createFighterEnvironment } from '../../env-fighter/src/environment';
import type { RunConfig } from './config';
import type { CliIo } from './io';

/**
 * What a run intends to do, and what is left of it.
 *
 * AD-9 in one sentence: **the resumable state is the set of committed Command
 * Logs.** No state file, no queue, no database -- INV-8 forbids the last of
 * those outright and the other two are the same mistake in a smaller box. The
 * plan is a pure function of the config, so the same config always produces
 * the same `matchId`s (AD-8), and "what is outstanding" is then just set
 * subtraction against what is on disk.
 */

const LOG_SUFFIX = '.command-log.json';

/**
 * The environment identity and config hash a CLI Match carries.
 *
 * Computed from `DEFAULT_FIGHTER_CONFIG` -- the CLI exposes no config
 * overrides, deliberately. Two logs of the same pairing and seed produced by
 * CI, by the CLI, or by `apps/web/src/testing/demo-log.ts` must agree on
 * `configHash` and therefore on `matchId`, or two datasets of the same Match
 * would be uncomparable for no reason. Adding overrides later is a config
 * field and a hash input; adding them now would be a divergence with no caller.
 */
const probeEnvironment = createFighterEnvironment();

export const CLI_ENVIRONMENT_ID = probeEnvironment.id;
export const CLI_ENVIRONMENT_VERSION = probeEnvironment.version;

export function cliConfigHash(): string {
  return computeConfigHash(DEFAULT_FIGHTER_CONFIG);
}

export interface PlannedMatch {
  readonly matchId: string;
  readonly seed: number;
  /** Side 0 first. */
  readonly agentIds: readonly [string, string];
}

export function planMatch(seed: number, agentIds: readonly [string, string]): PlannedMatch {
  return Object.freeze({
    matchId: computeMatchId({
      environmentId: CLI_ENVIRONMENT_ID,
      seed,
      configHash: cliConfigHash(),
      agentIds,
    }),
    seed,
    agentIds: Object.freeze([agentIds[0], agentIds[1]]) as readonly [string, string],
  });
}

/**
 * Round-robin: every unordered pair of declared Agents, over every seed, from
 * **both sides** (Story 7.1, AD-12).
 *
 * Until 7.1 the Agent at the lower declaration index played side 0 every time.
 * That is a side bias, and a pairing measured from one side only cannot tell a
 * side advantage in the Environment apart from a skill difference between the
 * two Agents -- the one thing a leaderboard exists to report. So each pairing
 * and seed now yields two Matches with the Agents in opposite array positions.
 *
 * They are separate Matches with distinct `matchId`s, never one Match carrying
 * a "sides swapped" flag. `computeMatchId` already hashes `agentIds` in order,
 * so the two orderings get their own ids, their own logs and their own resume
 * entries with no extra machinery.
 *
 * The two orientations are emitted **adjacently**. AD-9 makes the resumable
 * state the set of committed logs, so plan order decides what a killed segment
 * leaves behind: adjacency means an interruption leaves whole mirrored pairs
 * plus at most one half-pair. Emitting a one-sided pass and mirroring it
 * afterwards would leave an entire tournament of one-sided data on exactly the
 * interruption this project's five-segment schedule makes routine.
 *
 * Seed-major ordering, so an interrupted run has completed whole seeds rather
 * than a ragged prefix of one pairing. It costs nothing and makes a partial
 * output directory far easier to reason about.
 */
export function planTournament(config: RunConfig): readonly PlannedMatch[] {
  const planned: PlannedMatch[] = [];
  for (let offset = 0; offset < config.seedCount; offset += 1) {
    const seed = config.seedBase + offset;
    for (let first = 0; first < config.agents.length; first += 1) {
      for (let second = first + 1; second < config.agents.length; second += 1) {
        const lower = config.agents[first].id;
        const higher = config.agents[second].id;
        planned.push(planMatch(seed, [lower, higher]));
        planned.push(planMatch(seed, [higher, lower]));
      }
    }
  }
  return Object.freeze(planned);
}

export function logFileName(matchId: string): string {
  return `${matchId}${LOG_SUFFIX}`;
}

/** Forward slashes, always. Node accepts them on every platform, and the memory io is then not a second path implementation. */
export function joinPath(dir: string, name: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '');
  return trimmed === '' ? name : `${trimmed}/${name}`;
}

/**
 * Whether a committed log genuinely completes this planned Match.
 *
 * Presence of the file is not enough, and the reason is AC4's own scenario: a
 * process killed mid-write leaves a partial document, and a resume that
 * trusted the directory listing would skip a Match that never finished --
 * leaving a permanent hole in a tournament nobody re-runs. So the file is
 * parsed, validated against the frozen schema, and checked to carry the
 * `matchId` its own name claims.
 *
 * Every failure means "outstanding", never "error". Re-running a Match that
 * had in fact completed costs one Match; skipping one that had not costs the
 * dataset.
 */
async function isCommitted(io: CliIo, outputDir: string, match: PlannedMatch): Promise<boolean> {
  try {
    const text = await io.readFile(joinPath(outputDir, logFileName(match.matchId)));
    const log = validateCommandLog(JSON.parse(text));
    return log.matchId === match.matchId;
  } catch {
    return false;
  }
}

/**
 * The planned Matches with no committed log, in plan order.
 *
 * The directory listing is taken once and used as a cheap filter, so a
 * thousand-Match plan against an empty directory does no reads at all; only
 * the Matches whose file exists are parsed and validated.
 */
export async function outstandingMatches(
  planned: readonly PlannedMatch[],
  io: CliIo,
  outputDir: string,
): Promise<readonly PlannedMatch[]> {
  const present = new Set(await io.listFiles(outputDir));

  const outstanding: PlannedMatch[] = [];
  for (const match of planned) {
    if (!present.has(logFileName(match.matchId))) {
      outstanding.push(match);
      continue;
    }
    if (!(await isCommitted(io, outputDir, match))) {
      outstanding.push(match);
    }
  }
  return Object.freeze(outstanding);
}
