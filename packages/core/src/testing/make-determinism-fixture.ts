import type { Action, AgentIdentity, CommandLog } from '@tokenbrawl/contracts';
import { buildCommandLog, computeConfigHash } from '../command-log';
import { runMatch } from '../match-runner';
import { createScriptedAgent } from './mock-agent';
import { createMockEnvironment, DEFAULT_MOCK_ENVIRONMENT_CONFIG } from './mock-environment';

/**
 * The single source of truth for `fixtures/determinism.command-log.json`.
 *
 * The golden fixture is *committed*, not generated per test run: a log
 * generated inside the test that asserts on it is self-consistent by
 * construction and would keep passing even if the simulation's arithmetic
 * changed underneath it. Committing the log makes its recorded
 * `finalStateHash` a fact about the code at a point in time, so a future edit
 * to `mock-environment.ts` or `match-runner.ts` fails loudly instead of
 * silently re-baselining.
 *
 * This module keeps regeneration honest in the other direction: the same
 * function that produced the committed bytes is re-run by `replay.test.ts`
 * and compared against them, so the fixture can never drift into being a
 * hand-edited artefact whose hashes nobody can reproduce.
 */

export const DETERMINISM_FIXTURE_SEED = 42;

/**
 * Fixed scripts, sized for the worst case. With
 * `DEFAULT_MOCK_ENVIRONMENT_CONFIG` a Match is at most
 * `maxTicks / ticksPerDecision` Decision Points, and `createScriptedAgent`
 * *throws* when its script runs out, so each script carries one entry per
 * possible Decision Point. (Ticks where an Agent is inside a Commitment
 * Window consume nothing, so the tail is slack, never a silent truncation.)
 *
 * Composition is deliberate rather than arbitrary:
 *   - Each Agent lands exactly two `attack`s and one `special`, so their
 *     combined damage cannot deplete `initialHealth` and the Match reaches
 *     the `maxTicks` timeout -- giving the gate a long log rather than a
 *     three-Decision-Point KO.
 *   - Both `special`s guarantee real Commitment Windows, so the fixture
 *     exercises the "absent entry means the Agent was never polled" path
 *     that a log of nothing but `attack`s would leave untested.
 *   - The two scripts are not mirror images, so an agentIndex swap anywhere
 *     in the replay loop changes the hash instead of cancelling out.
 */
export const DETERMINISM_FIXTURE_P1_SCRIPT: readonly Action[] = [
  'advance',
  'attack',
  'block',
  'special',
  'retreat',
  'attack',
  'advance',
  'block',
  'retreat',
  'advance',
  'block',
  'retreat',
  'advance',
  'block',
  'retreat',
  'advance',
  'block',
  'retreat',
  'advance',
  'block',
];

export const DETERMINISM_FIXTURE_P2_SCRIPT: readonly Action[] = [
  'block',
  'advance',
  'attack',
  'retreat',
  'special',
  'advance',
  'block',
  'attack',
  'retreat',
  'advance',
  'block',
  'retreat',
  'advance',
  'block',
  'retreat',
  'advance',
  'block',
  'retreat',
  'advance',
  'block',
];

export const DETERMINISM_FIXTURE_AGENTS: readonly [AgentIdentity, AgentIdentity] = [
  { id: 'bot:p1', kind: 'bot' },
  { id: 'bot:p2', kind: 'bot' },
];

/**
 * Builds the golden Command Log. Pure with respect to everything the
 * simulation can observe: no wall clock, no ambient randomness, no
 * filesystem. Writing the result to disk is the caller's job (AD-1).
 */
export async function buildDeterminismFixture(): Promise<CommandLog> {
  const env = createMockEnvironment();

  const agent0 = createScriptedAgent({
    id: DETERMINISM_FIXTURE_AGENTS[0].id,
    kind: DETERMINISM_FIXTURE_AGENTS[0].kind,
    script: DETERMINISM_FIXTURE_P1_SCRIPT,
  });
  const agent1 = createScriptedAgent({
    id: DETERMINISM_FIXTURE_AGENTS[1].id,
    kind: DETERMINISM_FIXTURE_AGENTS[1].kind,
    script: DETERMINISM_FIXTURE_P2_SCRIPT,
  });

  const matchResult = await runMatch(env, [agent0, agent1], DETERMINISM_FIXTURE_SEED);

  return buildCommandLog(matchResult, {
    environment: { id: env.id, version: env.version },
    seed: DETERMINISM_FIXTURE_SEED,
    // The config the environment was actually built from, so the fixture's
    // configHash is verifiable by a caller holding the same config rather
    // than being an opaque constant.
    configHash: computeConfigHash(DEFAULT_MOCK_ENVIRONMENT_CONFIG),
    agents: DETERMINISM_FIXTURE_AGENTS,
  });
}

/**
 * The exact byte encoding of the committed fixture: two-space-indented JSON
 * with a trailing newline. Regeneration and the staleness check both route
 * through this, so neither can drift from the other on formatting.
 */
export function serialiseDeterminismFixture(log: CommandLog): string {
  return `${JSON.stringify(log, null, 2)}\n`;
}
