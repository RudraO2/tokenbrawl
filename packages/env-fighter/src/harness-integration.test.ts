import type { Action, AgentIdentity } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
// Deep relative imports into packages/core, not `@tokenbrawl/core`: none of
// these packages declares `main`/`exports`, so the bare specifier does not
// resolve at runtime (already logged in the deferred-work ledger). The
// direction is the allowed one -- AD-1 forbids core depending on an adapter,
// not the reverse -- and ESLint's `no-restricted-imports` block is scoped to
// `packages/core/**`, so nothing here is being worked around.
//
// Importing `./command-log` pulls in Ajv and, through `canonical-hash`,
// `node:crypto`. That is fine *here* and nowhere else in this package: a test
// file is never bundled into the web app, which is why AD-4's audit check and
// `source-discipline.test.ts` both exempt `*.test.ts`.
import {
  buildCommandLog,
  computeConfigHash,
  validateCommandLog,
} from '../../core/src/command-log';
import { runMatch } from '../../core/src/match-runner';
import { replayCommandLog } from '../../core/src/replay';
import { createScriptedAgent } from '../../core/src/testing/mock-agent';
import { DEFAULT_FIGHTER_CONFIG } from './config';
import { createFighterEnvironment } from './environment';

/**
 * The fighter driven by the real Harness, end to end.
 *
 * Until this file, every guarantee in this package was asserted by calling
 * `step()`/`hash()` directly, and every `runMatch`/`replayCommandLog` test in
 * `packages/core` ran against `mock-environment.ts`. The two halves had never
 * met: an adapter that satisfies `EnvironmentAdapter` in isolation can still
 * be undriveable by the Harness (an `isActionable` that never clears, a
 * `terminal()` the loop cannot reach, a state the Command Log cannot carry),
 * and nothing would have caught it before Epic 4 tried to render a replay.
 */

const SEED = 4242;

/** Long enough for the tick cap: 1200 / 30 = 40 Decision Points, and an Agent is polled at most once each. */
function repeatPattern(pattern: readonly Action[], length: number): readonly Action[] {
  return Array.from({ length }, (_unused, index) => pattern[index % pattern.length]);
}

const AGGRESSIVE = repeatPattern(['advance', 'advance', 'attack', 'attack', 'block'], 60);
const TURTLE = repeatPattern(['block'], 60);

const AGENT_IDS: readonly [AgentIdentity, AgentIdentity] = [
  { id: 'bot-aggressive', kind: 'bot' },
  { id: 'bot-turtle', kind: 'bot' },
];

function fighterAgents(first: readonly Action[], second: readonly Action[]) {
  return [
    createScriptedAgent({ id: 'bot-aggressive', kind: 'bot', script: first }),
    createScriptedAgent({ id: 'bot-turtle', kind: 'bot', script: second }),
  ] as const;
}

describe('env-fighter driven by the real Harness', () => {
  it('runs a Match to a terminal result through runMatch', async () => {
    const env = createFighterEnvironment();
    const result = await runMatch(env, fighterAgents(AGGRESSIVE, TURTLE), SEED);

    expect(result.finalStateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(['ko', 'timeout']).toContain(result.result.endReason);
    expect(result.result.endTick).toBeLessThanOrEqual(DEFAULT_FIGHTER_CONFIG.maxTicks);
    expect(result.decisions.length).toBeGreaterThan(0);
  });

  it('reaches the tick cap and reports a timeout when neither side can score', async () => {
    const env = createFighterEnvironment();
    const result = await runMatch(env, fighterAgents(TURTLE, TURTLE), SEED);

    expect(result.result.endReason).toBe('timeout');
    expect(result.result.endTick).toBe(DEFAULT_FIGHTER_CONFIG.maxTicks);
    expect(result.result.outcome).toBe('draw');
  });

  it('scores a KO when a fighter starts in range and the defender does not block', async () => {
    // Started in range deliberately rather than tuning an Action pattern to
    // close the gap in time: from the default 320-unit separation only one
    // side advances, `advanceCap` halves each step, and the aggressor lands
    // ~90 damage into a 100 health pool -- a timeout that turns on the exact
    // frame data Story 2.4 is going to change. This asserts the KO path is
    // reachable through the Harness, not what the numbers happen to be.
    // The defender advances rather than standing: `stand` is the Fallback
    // Action, and the frozen contract types `script` as `(Action | null)[]`
    // precisely so an Agent can never *choose* it. Advancing keeps the
    // defender in range without blocking, which is what this case needs.
    const env = createFighterEnvironment({ startPosition: [440, 520] });
    const brawler = repeatPattern(['attack'], 60);
    const closer = repeatPattern(['advance'], 60);
    const result = await runMatch(env, fighterAgents(brawler, closer), SEED);

    expect(result.result.endReason).toBe('ko');
    expect(result.result.outcome).toBe('p1');
    expect(result.result.healthRemaining[1]).toBe(0);
  });

  it('is polled once per actionable Agent per Decision Point, and never while committed', async () => {
    // The load-bearing claim in docs/ARCHITECTURE.md: not polling an Agent
    // mid-Commitment-Window is what keeps call volume inside free-tier
    // quotas. It only holds if the Harness actually honours *this* adapter's
    // isActionable, which nothing had checked.
    //
    // `specialMeterCost: 0` because meter starts at 0 and `special` is its
    // only consumer: at the default cost an Agent that only ever picks
    // `special` can never afford one, so it never commits and this case
    // would test nothing at all.
    const env = createFighterEnvironment({ specialMeterCost: 0 });
    const special = repeatPattern(['special'], 60);
    const [aggressor, defender] = fighterAgents(special, TURTLE);
    const result = await runMatch(env, [aggressor, defender], SEED);

    const notPolled = result.decisions.filter(
      (entry) => entry.agentIndex === 0 && entry.action === null,
    );
    expect(notPolled.length).toBeGreaterThan(0);

    const polled = result.decisions.filter(
      (entry) => entry.agentIndex === 0 && entry.action !== null,
    );
    expect(aggressor.decideCallCount()).toBe(polled.length);
    expect(defender.decideCallCount()).toBeGreaterThan(aggressor.decideCallCount());
  });

  it('leaves an Agent that only ever picks an unaffordable special fully inert', async () => {
    // Documents the 2.1 behaviour the case above had to configure around:
    // `special` below its meter cost is a no-op, so such an Agent is polled
    // at every Decision Point, commits to nothing, and loses on health.
    // Story 2.2 replaces this with an illegal-Action rejection that applies
    // the Fallback Action -- when it does, this expectation should change
    // with it rather than being quietly deleted.
    const env = createFighterEnvironment();
    const special = repeatPattern(['special'], 60);
    const [stubborn] = fighterAgents(special, TURTLE);
    const result = await runMatch(env, [stubborn, createScriptedAgent({
      id: 'bot-turtle',
      kind: 'bot',
      script: TURTLE,
    })], SEED);

    expect(
      result.decisions.filter((entry) => entry.agentIndex === 0 && entry.action === null),
    ).toStrictEqual([]);
    expect(result.result.endReason).toBe('timeout');
    expect(result.result.healthRemaining).toStrictEqual([
      DEFAULT_FIGHTER_CONFIG.initialHealth,
      DEFAULT_FIGHTER_CONFIG.initialHealth,
    ]);
  });

  it('produces a schema-valid Command Log', async () => {
    const env = createFighterEnvironment();
    const result = await runMatch(env, fighterAgents(AGGRESSIVE, TURTLE), SEED);

    const log = buildCommandLog(result, {
      environment: { id: env.id, version: env.version },
      seed: SEED,
      configHash: computeConfigHash(DEFAULT_FIGHTER_CONFIG),
      agents: AGENT_IDS,
    });

    expect(() => validateCommandLog(log)).not.toThrow();
    expect(log.environment).toStrictEqual({ id: 'fighter-1v1', version: '1.0.0' });
    expect(log.finalStateHash).toBe(result.finalStateHash);
    // Non-actionable ticks are filtered out of the log, so every entry that
    // survives carries a real Action.
    expect(log.decisions.every((entry) => entry.action !== null)).toBe(true);
  });

  it('replays that Command Log to a bit-identical Final-State Hash (INV-2)', async () => {
    const env = createFighterEnvironment();
    const result = await runMatch(env, fighterAgents(AGGRESSIVE, TURTLE), SEED);
    const log = buildCommandLog(result, {
      environment: { id: env.id, version: env.version },
      seed: SEED,
      configHash: computeConfigHash(DEFAULT_FIGHTER_CONFIG),
      agents: AGENT_IDS,
    });

    const replayed = replayCommandLog(log, createFighterEnvironment());

    expect(replayed.matchesRecordedHash).toBe(true);
    expect(replayed.finalStateHash).toBe(result.finalStateHash);
    expect(replayed.result).toStrictEqual(result.result);
  });

  it('detects a tampered log rather than replaying it happily', async () => {
    // Confirms the case above is a real check and not an identity.
    const env = createFighterEnvironment();
    const result = await runMatch(env, fighterAgents(AGGRESSIVE, TURTLE), SEED);
    const log = buildCommandLog(result, {
      environment: { id: env.id, version: env.version },
      seed: SEED,
      configHash: computeConfigHash(DEFAULT_FIGHTER_CONFIG),
      agents: AGENT_IDS,
    });

    const tampered = { ...log, seed: SEED + 1 };
    expect(replayCommandLog(tampered, createFighterEnvironment()).matchesRecordedHash).toBe(false);
  });

  it('produces identical Command Logs from identical seeds', async () => {
    const first = await runMatch(
      createFighterEnvironment(),
      fighterAgents(AGGRESSIVE, TURTLE),
      SEED,
    );
    const second = await runMatch(
      createFighterEnvironment(),
      fighterAgents(AGGRESSIVE, TURTLE),
      SEED,
    );

    expect(second.finalStateHash).toBe(first.finalStateHash);
    expect(second.decisions).toStrictEqual(first.decisions);
  });

  it('produces different Final-State Hashes from different seeds', async () => {
    const first = await runMatch(
      createFighterEnvironment(),
      fighterAgents(AGGRESSIVE, TURTLE),
      SEED,
    );
    const other = await runMatch(
      createFighterEnvironment(),
      fighterAgents(AGGRESSIVE, TURTLE),
      SEED + 1,
    );

    expect(other.finalStateHash).not.toBe(first.finalStateHash);
  });
});
