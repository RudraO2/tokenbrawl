import type { Agent, AgentIdentity, CommandLog } from '@tokenbrawl/contracts';
import { buildCommandLog } from '../../core/src/command-log';
import { runMatch } from '../../core/src/match-runner';
import { createFighterEnvironment } from '../../env-fighter/src/environment';
import { buildAgent, type AgentDeps } from './agents';
import { agentConfigById, type RunConfig } from './config';
import {
  CLI_ENVIRONMENT_ID,
  CLI_ENVIRONMENT_VERSION,
  cliConfigHash,
  joinPath,
  logFileName,
  type PlannedMatch,
} from './plan';

/**
 * AC1, and it is short on purpose.
 *
 * "It uses the same Harness and the same Command Log schema as CI -- no forked
 * logic anywhere." The way to satisfy that is not to be careful; it is to have
 * nothing to be careful about. `runMatch` is Story 1.2's Harness loop,
 * `buildCommandLog` is Story 1.3's builder (which validates against the frozen
 * schema before it returns), and `createFighterEnvironment` is the same
 * adapter the browser runs. This module composes those three and writes the
 * result. There is no serialiser here, no hasher, no schema literal and no
 * decision-entry mapping -- `source-discipline.test.ts` asserts that stays
 * true, because a second implementation of any of them is exactly the fork the
 * AC forbids.
 */

/**
 * Two-space JSON with a trailing newline.
 *
 * This is what a human diffing a committed replay wants, and it matches every
 * other JSON artifact in the repo. The byte-identity acceptance criterion is
 * about the *document* -- the same Match must produce the same log -- and
 * `run.test.ts` asserts that against a log built independently through core,
 * not against this function, so pinning the whitespace here cannot make that
 * test pass vacuously.
 */
export function serialiseCommandLog(log: CommandLog): string {
  return `${JSON.stringify(log, null, 2)}\n`;
}

export interface RunSummary {
  readonly planned: number;
  /** Already committed, and therefore not re-run (AC4). */
  readonly skipped: number;
  readonly completed: number;
  /** Paths written this run, in completion order. */
  readonly written: readonly string[];
  /**
   * Deployment ids parked during this run (Story 5.2, AC3). Any planned Match
   * naming one of these on either side was skipped rather than attempted --
   * not written, and therefore still outstanding for the next invocation.
   */
  readonly parked: readonly string[];
}

/**
 * Plays one planned Match and returns its Command Log.
 *
 * Exported because `main.ts`'s `match` command is exactly this with a plan of
 * one, and because a test that wants a log without a filesystem should not
 * have to go through a directory listing to get one.
 */
export async function runOneMatch(
  match: PlannedMatch,
  config: RunConfig,
  deps: AgentDeps,
): Promise<CommandLog> {
  const built = [0, 1].map((index) => {
    const agentIndex = index as 0 | 1;
    return buildAgent(agentConfigById(config, match.agentIds[agentIndex]), match.seed, agentIndex, deps);
  });

  const agents: readonly [Agent, Agent] = [built[0].agent, built[1].agent];
  const identities: readonly [AgentIdentity, AgentIdentity] = [built[0].identity, built[1].identity];

  const env = createFighterEnvironment();
  const result = await runMatch(env, agents, match.seed, {
    ...(config.tokenBankStart === undefined ? {} : { tokenBankStart: config.tokenBankStart }),
  });

  const log = buildCommandLog(result, {
    environment: { id: env.id, version: env.version },
    seed: match.seed,
    configHash: cliConfigHash(),
    agents: identities,
    ...(config.tokenBankStart === undefined ? {} : { tokenBankStart: config.tokenBankStart }),
  });

  // The plan derived this id before the Match ran; `buildCommandLog` derived
  // it again from what actually ran. They can only disagree if the plan and
  // the runner are working from different inputs -- a different environment
  // id, a different config hash, a swapped pair -- and that disagreement is
  // precisely what would make resume re-run completed Matches forever while
  // reporting success. Cheap to check, silent-and-permanent if not.
  if (log.matchId !== match.matchId) {
    throw new Error(
      `Planned matchId ${match.matchId} but the Match produced ${log.matchId}. ` +
        `The plan and the runner disagree about the Match's inputs; resume would never converge.`,
    );
  }
  if (log.environment.id !== CLI_ENVIRONMENT_ID || log.environment.version !== CLI_ENVIRONMENT_VERSION) {
    throw new Error(
      `Match ran against environment ${log.environment.id}@${log.environment.version}, ` +
        `but the plan was built for ${CLI_ENVIRONMENT_ID}@${CLI_ENVIRONMENT_VERSION}.`,
    );
  }

  return log;
}

/**
 * Runs a set of planned Matches, writing each log as it completes.
 *
 * Written as each Match finishes rather than batched at the end: that is what
 * makes an interrupted run resumable at all (AC4), because the committed logs
 * *are* the progress. A run killed at Match 40 of 200 leaves 40 files, and the
 * next invocation plans the same 200 and finds 160 outstanding.
 *
 * `planned` is the *outstanding* set, so `skipped` (already-committed) is
 * supplied by the caller -- this function never decides *that* kind of skip,
 * it only reports it. Parking (Story 5.2, AC3) is the one skip this function
 * does decide, because it can only be known partway through this very loop.
 */
export async function runPlannedMatches(
  planned: readonly PlannedMatch[],
  config: RunConfig,
  deps: AgentDeps,
  skipped = 0,
): Promise<RunSummary> {
  const written: string[] = [];

  if (planned.length > 0) {
    await deps.io.ensureDir(config.outputDir);
  }

  for (const match of planned) {
    // Story 5.2, AC3: a Deployment parked earlier in this run has its
    // remaining Matches skipped rather than attempted, on either side of the
    // pairing. Skipped, not failed -- the match stays outstanding and the
    // loop continues with whatever else is planned, which is exactly "parks
    // that Deployment's remaining Matches and continues with other
    // Deployments rather than failing the run".
    const parkedAgent = match.agentIds.find((id) => deps.quota?.isParked(id) ?? false);
    if (parkedAgent !== undefined) {
      deps.io.err(
        `parked: skipping ${match.matchId} (seed ${String(match.seed)}) -- "${parkedAgent}" is parked for this run.`,
      );
      continue;
    }

    const log = await runOneMatch(match, config, deps);
    const path = joinPath(config.outputDir, logFileName(log.matchId));
    // The io here is the *guarded* one (`main.ts` wraps it before any Match
    // exists), so a log carrying an API key is refused rather than written.
    await deps.io.writeFile(path, serialiseCommandLog(log));
    written.push(path);
    deps.io.out(`${log.matchId}  seed ${String(match.seed)}  ${match.agentIds.join(' vs ')}  ${log.result.outcome}`);
  }

  return Object.freeze({
    planned: planned.length + skipped,
    skipped,
    completed: written.length,
    written: Object.freeze(written),
    parked: deps.quota?.parked ?? Object.freeze([]),
  });
}
